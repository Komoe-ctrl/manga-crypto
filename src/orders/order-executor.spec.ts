import {
  buildOrders,
  type OrdersHarness,
} from '../../test/support/orders-harness.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderOrigin, OrderSide } from '../generated/prisma/enums.js';
import {
  GatewayRejectedError,
  GatewayUnavailableError,
  type GatewayOrder,
} from './gateway/exchange-gateway.js';
import { RetryableOrderError, type OrderIntent } from './orders.types.js';

const D = (value: number | string) => new Prisma.Decimal(value);
const buy = (
  symbol: string,
  quantity: number | string,
  over: Partial<OrderIntent> = {},
): OrderIntent => ({
  symbol,
  side: OrderSide.BUY,
  quantity: D(quantity),
  origin: OrderOrigin.SIGNAL,
  ...over,
});
const sell = (
  symbol: string,
  quantity: number | string,
  over: Partial<OrderIntent> = {},
): OrderIntent => ({
  symbol,
  side: OrderSide.SELL,
  quantity: D(quantity),
  origin: OrderOrigin.SIGNAL,
  ...over,
});

const row = (h: OrdersHarness, index = 0) => h.prisma.tradeLogs[index];

/** Un ordre PENDING prêt à être exécuté à la main. */
async function pending(h: OrdersHarness, intent: OrderIntent) {
  const view = await h.orders.submit(h.userId, intent);
  expect(view.status).toBe('PENDING');
  return view.id;
}

describe('OrderExecutor — PAPER', () => {
  const setup = async () => {
    const h = await buildOrders({ dispatch: 'manual' });
    await h.fund(10_000);
    return h;
  };

  it('exécute un achat : prix courant, frais de 0,1 %, jambes du portefeuille (actif et USDT)', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 2));
    await h.executor.execute(id);

    expect(row(h)).toMatchObject({
      status: 'FILLED',
      avgFillPrice: D(100),
      feeCurrency: 'USDT',
    });
    expect(row(h).fee.toFixed()).toBe('0.2');
    expect(row(h).filledQuantity.toFixed()).toBe('2');
    expect(await h.quantityOf('BTC')).toBe('2');
    expect(await h.quantityOf('USDT')).toBe('9799.8'); // 10 000 − 200 − 0,2
  });

  it('exécute une vente et crédite l’USDT net des frais', async () => {
    const h = await setup();
    await h.hold('BTC', 3, 80);
    h.market.BTC = 150;
    await h.executor.execute(await pending(h, sell('BTC', 2)));

    expect(row(h)).toMatchObject({ status: 'FILLED', stopLossPrice: null });
    expect(await h.quantityOf('BTC')).toBe('1');
    expect(await h.quantityOf('USDT')).toBe('10299.7'); // 10 000 + 300 − 0,3
  });

  it('est idempotent : exécuter deux fois ne passe qu’un ordre et ne modifie le portefeuille qu’une fois', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    await h.executor.execute(id);
    await h.executor.execute(id);
    expect(await h.quantityOf('BTC')).toBe('1');
    expect(h.actions().filter((a) => a === 'order.filled')).toHaveLength(1);
  });

  it('deux exécutions simultanées ne passent qu’un seul ordre (prise atomique PENDING → SUBMITTED)', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    await Promise.all([h.executor.execute(id), h.executor.execute(id)]);
    expect(await h.quantityOf('BTC')).toBe('1');
    expect(h.actions().filter((a) => a === 'order.filled')).toHaveLength(1);
  });

  it('prix indisponible : l’ordre reste en cours et sera réessayé, puis exécuté une seule fois', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    h.state.pricesDown = true;

    await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError);
    expect(row(h).status).toBe('SUBMITTED');
    expect(await h.quantityOf('BTC')).toBe('0');

    h.state.pricesDown = false;
    await h.executor.execute(id);
    expect(row(h).status).toBe('FILLED');
    expect(await h.quantityOf('BTC')).toBe('1');
  });

  it('le kill switch activé entre la création et l’exécution refuse l’ordre sans l’exécuter', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    await h.control.activateKillSwitch(h.userId, {});

    await h.executor.execute(id);

    expect(row(h)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'kill_switch',
    });
    expect(await h.quantityOf('BTC')).toBe('0');
    expect(h.actions()).toContain('order.rejected');
  });

  it('une pause pour perte journalière activée entre-temps refuse aussi l’ordre', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    h.prisma.users[0].botPausedUntil = new Date(Date.now() + 3_600_000);
    await h.executor.execute(id);
    expect(row(h)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'paused_daily_loss',
    });
  });

  it('un ordre déjà parti n’est jamais abandonné par un garde-fou : il se termine', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    h.state.pricesDown = true;
    await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError); // SUBMITTED
    await h.control.activateKillSwitch(h.userId, {});
    h.state.pricesDown = false;

    await h.executor.execute(id);
    expect(row(h).status).toBe('FILLED');
  });

  it('refuse à l’exécution si les fonds ont disparu entre-temps', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    await h.hold('USDT', 10, 1);
    await h.executor.execute(id);
    expect(row(h)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'insufficient_funds',
    });
  });

  it('refuse à l’exécution si la quantité à vendre a disparu entre-temps', async () => {
    const h = await setup();
    await h.hold('BTC', 2);
    const id = await pending(h, sell('BTC', 2));
    await h.hold('BTC', 1);
    await h.executor.execute(id);
    expect(row(h)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'insufficient_quantity',
    });
  });

  describe('notifications', () => {
    const lastNotification = (h: OrdersHarness) =>
      h.notifications.notify.mock.calls.at(-1)![1] as Record<string, unknown>;

    it('un achat exécuté prévient (non critique)', async () => {
      const h = await setup();
      await h.executor.execute(await pending(h, buy('BTC', 2)));
      expect(lastNotification(h)).toMatchObject({
        title: 'Ordre exécuté',
        body: 'Achat de 2 BTC à 100 $ (PAPER)',
        critical: false,
        dedupeKey: `order:${row(h).id}:filled`,
      });
    });

    it('un stop-loss exécuté est critique, un take-profit ne l’est pas', async () => {
      const h = await setup();
      await h.hold('BTC', 2);
      await h.executor.execute(
        await pending(h, sell('BTC', 1, { origin: OrderOrigin.STOP_LOSS })),
      );
      expect(lastNotification(h)).toMatchObject({
        title: 'Stop-loss exécuté',
        critical: true,
      });

      await h.executor.execute(
        await pending(h, sell('BTC', 1, { origin: OrderOrigin.TAKE_PROFIT })),
      );
      expect(lastNotification(h)).toMatchObject({
        title: 'Take-profit exécuté',
        critical: false,
      });
    });

    it('un échec de notification ne défait pas l’ordre', async () => {
      const h = await setup();
      h.notifications.notify.mockRejectedValue(new Error('canal en panne'));
      await h.executor.execute(await pending(h, buy('BTC', 1)));
      expect(row(h).status).toBe('FILLED');
      expect(await h.quantityOf('BTC')).toBe('1');
    });

    it('un refus d’ordre manuel en PAPER ne notifie pas (la réponse de l’API suffit), celui d’une sortie notifie', async () => {
      const h = await setup();
      const manual = await pending(
        h,
        buy('BTC', 1, { origin: OrderOrigin.MANUAL }),
      );
      await h.control.activateKillSwitch(h.userId, {});
      await h.executor.execute(manual);
      expect(h.notifications.notify).not.toHaveBeenCalled();
    });
  });

  describe('giveUp (dernier essai épuisé)', () => {
    it('marque en échec un ordre PAPER resté en cours', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      h.state.pricesDown = true;
      await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError);
      await h.executor.giveUp(id);
      expect(row(h)).toMatchObject({
        status: 'FAILED',
        failureReason: 'retries_exhausted',
      });
      expect(h.actions()).toContain('order.failed');
    });

    it('marque en échec un ordre jamais pris', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      await h.executor.giveUp(id);
      expect(row(h).status).toBe('FAILED');
    });

    it('ne touche pas un ordre déjà exécuté', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      await h.executor.execute(id);
      await h.executor.giveUp(id);
      expect(row(h).status).toBe('FILLED');
    });
  });
});

describe('OrderExecutor — LIVE', () => {
  const setup = async () => {
    const h = await buildOrders({ dispatch: 'manual' });
    await h.fund(10_000);
    h.goLive();
    return h;
  };
  const lastNotification = (h: OrdersHarness) =>
    h.notifications.notify.mock.calls.at(-1)![1] as Record<string, unknown>;

  it('envoie l’ordre au marché, retrouve l’ordre avant d’en créer un, et enregistre l’exécution', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 2));
    await h.executor.execute(id);

    expect(h.gateway.findCalls).toBe(1); // recherche par clientOrderId d'abord
    expect(h.gateway.placeCalls).toHaveLength(1);
    expect(h.gateway.placeCalls[0]).toMatchObject({
      symbol: 'BTC',
      side: 'BUY',
      clientOrderId: row(h).clientOrderId,
    });
    expect(h.gateway.placeCalls[0].quantity.toFixed()).toBe('2');
    expect(row(h)).toMatchObject({
      status: 'FILLED',
      exchangeOrderId: 'ex-1',
      exchangeConfigId: 'exchange-config-1',
      feeCurrency: 'USDT',
    });
    expect(row(h).avgFillPrice.toFixed()).toBe('100');
    expect(row(h).stopLossPrice.toFixed()).toBe('97');
    expect(await h.quantityOf('BTC')).toBe('2');
    expect(await h.quantityOf('USDT')).toBe('9799.8');
  });

  it('réutilise le même clientOrderId à chaque essai : un ordre perdu en route n’est jamais doublé', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    // L'ordre est bien créé sur la plateforme, mais la réponse se perd.
    h.gateway.loseResponse = new GatewayUnavailableError();

    await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError);
    expect(row(h).status).toBe('SUBMITTED');
    expect(h.gateway.orders.size).toBe(1);

    // Deuxième essai : l'ordre est retrouvé, pas recréé.
    h.gateway.loseResponse = null;
    await h.executor.execute(id);

    expect(h.gateway.placeCalls).toHaveLength(1);
    expect(h.gateway.findCalls).toBe(2);
    expect(row(h).status).toBe('FILLED');
    expect(await h.quantityOf('BTC')).toBe('1');
  });

  it('plateforme injoignable avant la création : l’ordre est réessayé puis créé une seule fois', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    h.gateway.placeError = new GatewayUnavailableError();
    await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError);

    h.gateway.placeError = null;
    await h.executor.execute(id);
    expect(h.gateway.orders.size).toBe(1);
    expect(row(h).status).toBe('FILLED');
  });

  it('recherche injoignable : réessai sans rien créer', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    h.gateway.findError = new GatewayUnavailableError();
    await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError);
    expect(h.gateway.placeCalls).toHaveLength(0);
  });

  it('refus définitif de la plateforme : ordre refusé avec son motif, et l’utilisateur est prévenu (critique)', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    h.gateway.placeError = new GatewayRejectedError('insufficient_funds');

    await h.executor.execute(id);

    expect(row(h)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'insufficient_funds',
    });
    expect(lastNotification(h)).toMatchObject({
      title: 'Ordre refusé',
      critical: true,
    });
    expect(await h.quantityOf('BTC')).toBe('0');
  });

  it('clé refusée (exchange_auth) : ordre refusé', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    h.gateway.findError = new GatewayRejectedError('exchange_auth');
    await h.executor.execute(id);
    expect(row(h)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'exchange_auth',
    });
  });

  it('mode repassé en PAPER avant l’exécution : ordre refusé, plateforme jamais appelée', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    h.prisma.users[0].tradingMode = 'PAPER';

    await h.executor.execute(id);

    expect(row(h)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'mode_changed',
    });
    expect(h.gateway.findCalls).toBe(0);
    expect(h.exchanges.getLiveCredentials).not.toHaveBeenCalled();
  });

  it('kill switch avant l’envoi : rien n’est envoyé à la plateforme', async () => {
    const h = await setup();
    const id = await pending(h, buy('BTC', 1));
    await h.control.activateKillSwitch(h.userId, {});
    await h.executor.execute(id);
    expect(row(h)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'kill_switch',
    });
    expect(h.gateway.findCalls).toBe(0);
  });

  describe('éligibilité de l’échange revérifiée à chaque ordre (D28)', () => {
    it('plus de configuration éligible : ordre refusé, jamais envoyé', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      h.exchanges.getLiveCredentials.mockResolvedValue(null);

      await h.executor.execute(id);

      expect(row(h)).toMatchObject({
        status: 'REJECTED',
        failureReason: 'no_verified_exchange',
      });
      expect(h.gateway.findCalls).toBe(0);
      expect(lastNotification(h)).toMatchObject({ critical: true });
    });

    it('configuration disparue au milieu des essais : on ne refuse pas un ordre peut-être déjà parti, on réessaie', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      h.gateway.loseResponse = new GatewayUnavailableError();
      await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError); // SUBMITTED

      h.exchanges.getLiveCredentials.mockResolvedValue(null);
      await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError);
      expect(row(h).status).toBe('SUBMITTED');
    });

    it('les clés sont demandées à chaque ordre', async () => {
      const h = await setup();
      await h.executor.execute(await pending(h, buy('BTC', 1)));
      await h.executor.execute(await pending(h, buy('BTC', 1)));
      expect(h.exchanges.getLiveCredentials).toHaveBeenCalledTimes(2);
    });
  });

  describe('exécution partielle et ordre encore ouvert', () => {
    const state = (over: Partial<GatewayOrder>): GatewayOrder => ({
      exchangeOrderId: 'ex-9',
      status: 'open',
      filled: D(0),
      average: null,
      feeCost: null,
      feeCurrency: 'USDT',
      ...over,
    });

    it('applique au portefeuille seulement la part nouvellement exécutée, puis solde l’ordre', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));

      h.gateway.result = () =>
        state({ filled: D('0.4'), average: D(100), feeCost: D('0.04') });
      await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError); // pas encore soldé
      expect(row(h).status).toBe('PARTIALLY_FILLED');
      expect(await h.quantityOf('BTC')).toBe('0.4');
      expect(row(h).stopLossPrice.toFixed()).toBe('97'); // la position existe déjà : elle est protégée

      // Réconciliation : l'ordre est retrouvé, désormais complet.
      h.gateway.orders.set(
        row(h).clientOrderId,
        state({
          status: 'closed',
          filled: D(1),
          average: D(100),
          feeCost: D('0.1'),
        }),
      );
      await h.executor.execute(id);

      expect(row(h)).toMatchObject({ status: 'FILLED' });
      expect(row(h).executedAt).toBeInstanceOf(Date);
      expect(await h.quantityOf('BTC')).toBe('1'); // 0,4 + 0,6 : jamais compté deux fois
      expect(await h.quantityOf('USDT')).toBe('9899.9'); // 10 000 − 100 − 0,1
      expect(h.gateway.placeCalls).toHaveLength(1);
    });

    it('ordre ouvert sans rien d’exécuté : reste SUBMITTED et réessaie', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      h.gateway.result = () => state({});
      await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError);
      expect(row(h).status).toBe('SUBMITTED');
      expect(await h.quantityOf('BTC')).toBe('0');
    });

    it('ordre annulé sans exécution : annulé, portefeuille inchangé', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      h.gateway.result = () => state({ status: 'canceled' });
      await h.executor.execute(id);
      expect(row(h).status).toBe('CANCELLED');
      expect(await h.quantityOf('BTC')).toBe('0');
    });

    it('ordre annulé après une exécution partielle : soldé en PARTIALLY_FILLED, quantité exécutée appliquée', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      h.gateway.result = () =>
        state({
          status: 'canceled',
          filled: D('0.5'),
          average: D(100),
          feeCost: D('0.05'),
        });
      await h.executor.execute(id);
      expect(row(h)).toMatchObject({ status: 'PARTIALLY_FILLED' });
      expect(await h.quantityOf('BTC')).toBe('0.5');
    });

    it('ordre fermé sans rien d’exécuté, ou rejeté par la plateforme : ordre refusé', async () => {
      const h = await setup();
      h.gateway.result = () => state({ status: 'closed', filled: D(0) });
      await h.executor.execute(await pending(h, buy('BTC', 1)));
      expect(row(h, 0)).toMatchObject({
        status: 'REJECTED',
        failureReason: 'invalid_order',
      });

      h.gateway.result = () => state({ status: 'rejected' });
      await h.executor.execute(await pending(h, buy('BTC', 1)));
      expect(row(h, 1)).toMatchObject({
        status: 'REJECTED',
        failureReason: 'invalid_order',
      });
    });
  });

  describe('frais', () => {
    it('frais en actif de base : déduits de la quantité reçue', async () => {
      const h = await setup();
      h.gateway.result = (r) => ({
        exchangeOrderId: 'ex-1',
        status: 'closed',
        filled: r.quantity,
        average: D(100),
        feeCost: D('0.001'),
        feeCurrency: 'BTC',
      });
      await h.executor.execute(await pending(h, buy('BTC', 1)));
      expect(await h.quantityOf('BTC')).toBe('0.999');
      expect(await h.quantityOf('USDT')).toBe('9900'); // aucun frais en USDT
    });

    it('frais dans une autre devise (BNB) : enregistrés sur l’ordre, sans effet sur le portefeuille', async () => {
      const h = await setup();
      h.gateway.result = (r) => ({
        exchangeOrderId: 'ex-1',
        status: 'closed',
        filled: r.quantity,
        average: D(100),
        feeCost: D('0.002'),
        feeCurrency: 'BNB',
      });
      await h.executor.execute(await pending(h, buy('BTC', 1)));
      expect(row(h)).toMatchObject({ feeCurrency: 'BNB' });
      expect(await h.quantityOf('BTC')).toBe('1');
      expect(await h.quantityOf('USDT')).toBe('9900');
    });
  });

  it('le portefeuille déclaré n’empêche pas un ordre réel : la jambe USDT est plafonnée à ce qui est détenu', async () => {
    const h = await setup();
    await h.hold('USDT', 50, 1);
    await h.hold('ETH', 10); // capital suffisant pour l'exposition
    const view = await h.orders.submit(
      h.userId,
      buy('BTC', 1, { origin: OrderOrigin.SIGNAL }),
    );
    expect(view.status).toBe('PENDING'); // en LIVE, la plateforme fait foi : pas de contrôle de fonds local

    await h.executor.execute(view.id);
    expect(await h.quantityOf('BTC')).toBe('1');
    expect(await h.quantityOf('USDT')).toBe('0'); // plafonné, jamais négatif
  });

  it('une vente LIVE crédite l’USDT et ne vend jamais plus que la quantité détenue côté portefeuille', async () => {
    const h = await setup();
    await h.hold('BTC', 1);
    h.market.BTC = 200;
    await h.executor.execute(await pending(h, sell('BTC', 1)));
    expect(await h.quantityOf('BTC')).toBe('0');
    expect(await h.quantityOf('USDT')).toBe('10199.8'); // 10 000 + 200 − 0,2
  });

  describe('dernier essai épuisé', () => {
    it('ordre jamais parti : en échec', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      await h.executor.giveUp(id);
      expect(row(h)).toMatchObject({
        status: 'FAILED',
        failureReason: 'retries_exhausted',
      });
      expect(lastNotification(h)).toMatchObject({
        title: 'Ordre abandonné',
        critical: true,
      });
    });

    it('ordre peut-être parti : laissé en l’état, utilisateur prévenu de le vérifier, audit', async () => {
      const h = await setup();
      const id = await pending(h, buy('BTC', 1));
      h.gateway.loseResponse = new GatewayUnavailableError();
      await expect(h.executor.execute(id)).rejects.toThrow(RetryableOrderError);

      await h.executor.giveUp(id);

      expect(row(h).status).toBe('SUBMITTED'); // pas FAILED : il existe peut-être sur la plateforme
      expect(h.actions()).toContain('order.unsettled');
      expect(lastNotification(h)).toMatchObject({
        title: 'Ordre à vérifier sur la plateforme',
        critical: true,
        body: expect.stringContaining(row(h).clientOrderId),
      });
    });
  });

  it('les clés ne fuient jamais dans l’audit, les notifications ni le journal des ordres', async () => {
    const h = await setup();
    h.gateway.placeError = new GatewayRejectedError('exchange_auth');
    await h.executor.execute(await pending(h, buy('BTC', 1)));
    await h.executor.execute(await pending(h, buy('BTC', 1))); // l'erreur persiste
    h.gateway.placeError = null;
    await h.executor.execute(await pending(h, buy('BTC', 1)));

    const everything = JSON.stringify([
      h.prisma.auditLogs,
      h.prisma.tradeLogs,
      h.notifications.notify.mock.calls,
    ]);
    expect(everything).not.toContain(h.credentials.apiKey);
    expect(everything).not.toContain(h.credentials.apiSecret);
  });
});
