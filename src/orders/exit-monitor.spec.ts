import {
  buildOrders,
  type OrdersHarness,
} from '../../test/support/orders-harness.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderOrigin, OrderSide } from '../generated/prisma/enums.js';
import { PriceUnavailableError } from '../portfolio/price/price-provider.js';

const D = (value: number | string) => new Prisma.Decimal(value);

/** Un achat exécuté en PAPER à 100 : stop-loss à 97, take-profit à 106 (réglages par défaut). */
async function withOpenPosition(quantity = 2) {
  const h = await buildOrders();
  await h.fund(10_000);
  const entry = await h.orders.submit(h.userId, {
    symbol: 'BTC',
    side: OrderSide.BUY,
    quantity: D(quantity),
    origin: OrderOrigin.MANUAL,
  });
  expect(entry).toMatchObject({
    status: 'FILLED',
    stopLossPrice: '97',
    takeProfitPrice: '106',
  });
  h.notifications.notify.mockClear();
  return { h, entry };
}

const exits = (h: OrdersHarness) =>
  h.prisma.tradeLogs.filter(
    (t) => t.origin === 'STOP_LOSS' || t.origin === 'TAKE_PROFIT',
  );
const notifications = (h: OrdersHarness) =>
  h.notifications.notify.mock.calls.map((c) => c[1] as Record<string, unknown>);

describe('ExitMonitor', () => {
  it('ne fait rien tant que le prix reste entre le stop-loss et le take-profit', async () => {
    const { h } = await withOpenPosition();
    for (const price of [97.01, 100, 105.99]) {
      h.market.BTC = price;
      expect(await h.monitor.run()).toMatchObject({ watched: 1, triggered: 0 });
    }
    expect(exits(h)).toHaveLength(0);
  });

  it('stop-loss : vend la quantité de l’entrée, programme la sortie sur la position et prévient (critique)', async () => {
    const { h, entry } = await withOpenPosition(2);
    h.market.BTC = 96.9;

    expect(await h.monitor.run()).toMatchObject({
      watched: 1,
      triggered: 1,
      blocked: 0,
      failed: 0,
    });

    const [exit] = exits(h);
    expect(exit).toMatchObject({
      origin: 'STOP_LOSS',
      side: 'SELL',
      status: 'FILLED',
      parentOrderId: entry.id,
    });
    expect(exit.quantity.toFixed()).toBe('2');
    expect(exit.avgFillPrice.toFixed()).toBe('96.9');
    expect(h.prisma.tradeLogs[0].exitTriggeredAt).toBeInstanceOf(Date); // la position n'est plus surveillée
    expect(await h.quantityOf('BTC')).toBe('0');
    expect(notifications(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Stop-loss exécuté', critical: true }),
      ]),
    );
    expect(h.actions()).toEqual(
      expect.arrayContaining(['order.exit_triggered', 'order.filled']),
    );
  });

  it('le stop-loss est déclenché à la limite exacte', async () => {
    const { h } = await withOpenPosition();
    h.market.BTC = 97;
    expect(await h.monitor.run()).toMatchObject({ triggered: 1 });
  });

  it('take-profit : vend et prévient sans caractère critique', async () => {
    const { h } = await withOpenPosition();
    h.market.BTC = 106;

    expect(await h.monitor.run()).toMatchObject({ triggered: 1 });

    expect(exits(h)[0]).toMatchObject({
      origin: 'TAKE_PROFIT',
      status: 'FILLED',
    });
    expect(notifications(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Take-profit exécuté',
          critical: false,
        }),
      ]),
    );
  });

  it('ne déclenche la sortie d’une position qu’une seule fois', async () => {
    const { h } = await withOpenPosition();
    h.market.BTC = 90;
    await h.monitor.run();
    expect(await h.monitor.run()).toMatchObject({ watched: 0, triggered: 0 });
    expect(exits(h)).toHaveLength(1);
  });

  it('deux passages simultanés ne vendent qu’une fois (prise atomique de la position)', async () => {
    const { h } = await withOpenPosition();
    h.market.BTC = 90;
    await Promise.all([h.monitor.run(), h.monitor.run()]);
    expect(exits(h)).toHaveLength(1);
    expect(await h.quantityOf('BTC')).toBe('0');
  });

  it('ne surveille ni les ventes ni les positions déjà sorties', async () => {
    const { h } = await withOpenPosition();
    h.market.BTC = 90;
    await h.monitor.run();
    // Il reste la vente de sortie (FILLED, sans stop-loss) et l'entrée sortie : rien à surveiller.
    expect((await h.monitor.run()).watched).toBe(0);
  });

  describe('robot arrêté ou en pause', () => {
    it('kill switch : aucune vente, le déclenchement n’est pas consommé, l’utilisateur est prévenu une fois par jour', async () => {
      const { h } = await withOpenPosition();
      await h.control.activateKillSwitch(h.userId, {});
      h.market.BTC = 90;

      expect(await h.monitor.run()).toMatchObject({ triggered: 0, blocked: 1 });
      await h.monitor.run();

      expect(exits(h)).toHaveLength(0);
      expect(h.prisma.tradeLogs[0].exitTriggeredAt).toBeNull();
      const blocked = h.notifications.notify.mock.calls.filter(([, input]) =>
        (input as { title: string }).title.includes('non passé'),
      );
      expect(blocked).toHaveLength(2); // une par passage ici ; la déduplication par jour est portée par `dedupeKey`
      expect(blocked[0][1]).toMatchObject({
        critical: true,
        dedupeKey: expect.stringMatching(/^exit-blocked:.+:\d{4}-\d{2}-\d{2}$/),
        body: expect.stringContaining('arrêté (kill switch)'),
      });
      expect(blocked[0][1]).toEqual(blocked[1][1]);
    });

    it('la sortie part dès que le robot repart', async () => {
      const { h } = await withOpenPosition();
      await h.control.activateKillSwitch(h.userId, {});
      h.market.BTC = 90;
      await h.monitor.run();

      await h.control.deactivateKillSwitch(h.userId, {});
      expect(await h.monitor.run()).toMatchObject({ triggered: 1, blocked: 0 });
      expect(exits(h)).toHaveLength(1);
    });

    it('pause pour perte journalière : même traitement', async () => {
      const { h } = await withOpenPosition();
      h.prisma.users[0].botPausedUntil = new Date(Date.now() + 3_600_000);
      h.market.BTC = 90;

      expect(await h.monitor.run()).toMatchObject({ blocked: 1, triggered: 0 });
      expect(notifications(h)[0].body).toContain('en pause');
    });
  });

  describe('quantité à vendre', () => {
    it('ne vend jamais plus que ce qui est détenu (vente manuelle partielle entre-temps)', async () => {
      const { h } = await withOpenPosition(2);
      await h.hold('BTC', 0.5);
      h.market.BTC = 90;
      await h.monitor.run();
      expect(exits(h)[0].quantity.toFixed()).toBe('0.5');
    });

    it('position déjà vendue : rien à vendre, déclenchement consommé, audité', async () => {
      const { h } = await withOpenPosition();
      await h.hold('BTC', 1);
      h.prisma.assets = h.prisma.assets.filter((a) => a.symbol !== 'BTC');
      h.market.BTC = 90;

      expect(await h.monitor.run()).toMatchObject({ triggered: 0 });
      expect(exits(h)).toHaveLength(0);
      expect(h.prisma.tradeLogs[0].exitTriggeredAt).toBeInstanceOf(Date);
      expect(h.prisma.auditLogs.at(-1)).toMatchObject({
        action: 'order.exit_skipped',
        metadata: { reason: 'nothing_to_sell' },
      });
    });
  });

  describe('prix manquants : on ne conclut pas', () => {
    it('source de prix injoignable : aucun déclenchement, pas d’erreur', async () => {
      const { h } = await withOpenPosition();
      h.market.BTC = 90;
      h.provider.getPrices.mockRejectedValueOnce(new PriceUnavailableError());
      expect(await h.monitor.run()).toMatchObject({
        watched: 1,
        triggered: 0,
        failed: 0,
      });
      expect(h.prisma.tradeLogs[0].exitTriggeredAt).toBeNull();
    });

    it('symbole sans prix : ignoré', async () => {
      const { h } = await withOpenPosition();
      h.market.BTC = null;
      expect(await h.monitor.run()).toMatchObject({ triggered: 0 });
    });
  });

  it('sortie refusée (ex. plus d’échange éligible en LIVE) : déclenchement conservé, utilisateur prévenu en critique', async () => {
    const { h } = await withOpenPosition();
    h.goLive();
    h.exchanges.getLiveCredentials.mockResolvedValue(null);
    h.market.BTC = 90;

    // En LIVE, l'ordre de sortie passe par l'exécution : la sortie est une intention automatique, pas un ordre manuel.
    expect(await h.monitor.run()).toMatchObject({ triggered: 1 });

    expect(exits(h)[0]).toMatchObject({
      status: 'REJECTED',
      failureReason: 'no_verified_exchange',
    });
    expect(h.prisma.tradeLogs[0].exitTriggeredAt).toBeInstanceOf(Date); // pas de boucle d'ordres refusés chaque minute
    expect(
      notifications(h).some(
        (n) => n.critical === true && String(n.title).includes('Ordre refusé'),
      ),
    ).toBe(true);
  });

  it('une erreur sur une position n’empêche pas la surveillance des suivantes', async () => {
    const h = await buildOrders();
    await h.fund(100_000);
    for (const quantity of [1, 2]) {
      await h.orders.submit(h.userId, {
        symbol: 'BTC',
        side: OrderSide.BUY,
        quantity: D(quantity),
        origin: OrderOrigin.MANUAL,
      });
    }
    h.market.BTC = 90;
    const submit = vi
      .spyOn(h.orders, 'submit')
      .mockRejectedValueOnce(new Error('base indisponible'));

    expect(await h.monitor.run()).toMatchObject({
      watched: 2,
      failed: 1,
      triggered: 1,
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('surveille aussi une entrée LIVE partiellement exécutée (la position existe)', async () => {
    const h = await buildOrders();
    h.prisma.tradeLogs.push({
      id: 'entry-1',
      userId: h.userId,
      symbol: 'BTC/USDT',
      side: 'BUY',
      status: 'PARTIALLY_FILLED',
      filledQuantity: D('0.5'),
      stopLossPrice: D(97),
      takeProfitPrice: D(106),
      exitTriggeredAt: null,
    });
    h.market.BTC = 106;
    expect((await h.monitor.run()).watched).toBe(1);
  });
});
