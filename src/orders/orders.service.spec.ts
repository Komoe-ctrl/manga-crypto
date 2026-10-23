import { ConflictException, NotFoundException } from '@nestjs/common';
import { buildOrders } from '../../test/support/orders-harness.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderOrigin, OrderSide } from '../generated/prisma/enums.js';
import type { OrderIntent } from './orders.types.js';

const D = (value: number | string) => new Prisma.Decimal(value);
const buy = (
  symbol: string,
  quantity: number | string,
  over: Partial<OrderIntent> = {},
): OrderIntent => ({
  symbol,
  side: OrderSide.BUY,
  quantity: D(quantity),
  origin: OrderOrigin.MANUAL,
  ...over,
});
const sell = (symbol: string, quantity: number | string): OrderIntent => ({
  symbol,
  side: OrderSide.SELL,
  quantity: D(quantity),
  origin: OrderOrigin.MANUAL,
});

describe('OrdersService', () => {
  describe('ordre accepté (PAPER)', () => {
    it('exécute un achat, programme stop-loss et take-profit et met à jour le portefeuille', async () => {
      const h = await buildOrders();
      await h.fund(10_000);

      const order = await h.orders.submit(h.userId, buy('BTC', 1));

      expect(order).toMatchObject({
        status: 'FILLED',
        mode: 'PAPER',
        symbol: 'BTC/USDT',
        side: 'BUY',
        type: 'MARKET',
        origin: 'MANUAL',
        quantity: '1',
        filledQuantity: '1',
        avgFillPrice: '100',
        fee: '0.1',
        feeCurrency: 'USDT',
        stopLossPrice: '97', // −3 % (réglage par défaut)
        takeProfitPrice: '106', // +6 %
        failureReason: null,
      });
      expect(order.executedAt).toBeInstanceOf(Date);
      expect(await h.quantityOf('BTC')).toBe('1');
      expect(await h.quantityOf('USDT')).toBe('9899.9'); // 10 000 − 100 − 0,1 de frais
      expect(h.actions()).toEqual(
        expect.arrayContaining(['order.submitted', 'order.filled']),
      );
    });

    it('exécute une vente, sans stop-loss ni take-profit', async () => {
      const h = await buildOrders();
      await h.fund(1000);
      await h.hold('BTC', 2, 90);
      h.market.BTC = 120;

      const order = await h.orders.submit(h.userId, sell('BTC', 1));

      expect(order).toMatchObject({
        status: 'FILLED',
        side: 'SELL',
        avgFillPrice: '120',
        fee: '0.12',
        stopLossPrice: null,
        takeProfitPrice: null,
      });
      expect(await h.quantityOf('BTC')).toBe('1');
      expect(await h.quantityOf('USDT')).toBe('1119.88'); // 1 000 + 120 − 0,12
    });

    it('applique les réglages de risque de l’utilisateur au stop-loss et au take-profit', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      h.prisma.riskSettingsRows[0].defaultStopLossPct = D(5);
      h.prisma.riskSettingsRows[0].defaultTakeProfitPct = D(10);

      const order = await h.orders.submit(h.userId, buy('BTC', 1));
      expect(order).toMatchObject({
        stopLossPrice: '95',
        takeProfitPrice: '110',
      });
    });

    it('génère un clientOrderId unique, de 35 caractères, par ordre, et met l’ordre en file une fois', async () => {
      const h = await buildOrders({ dispatch: 'manual' });
      await h.fund(10_000);

      const a = await h.orders.submit(h.userId, buy('BTC', 1));
      const b = await h.orders.submit(h.userId, buy('BTC', 1));

      expect(a.clientOrderId).toMatch(/^vl-[0-9a-f]{32}$/);
      expect(a.clientOrderId).toHaveLength(35);
      expect(a.clientOrderId).not.toBe(b.clientOrderId);
      expect(a.status).toBe('PENDING');
      expect(h.dispatched).toEqual([a.id, b.id]);
    });

    it('enregistre l’origine du signal pour la traçabilité', async () => {
      const h = await buildOrders({ dispatch: 'manual' });
      await h.fund(10_000);
      await h.orders.submit(
        h.userId,
        buy('BTC', 1, {
          origin: OrderOrigin.SIGNAL,
          signalStreamId: '1729-0',
          signalPayload: { action: 'BUY', score: 0.82 },
        }),
      );
      expect(h.prisma.tradeLogs[0]).toMatchObject({
        origin: 'SIGNAL',
        signalStreamId: '1729-0',
        signalPayload: { action: 'BUY', score: 0.82 },
      });
    });
  });

  describe('ordre refusé : enregistré avec son motif, jamais exécuté, jamais perdu', () => {
    const rejected = async (
      h: Awaited<ReturnType<typeof buildOrders>>,
      intent: OrderIntent,
      reason: string,
    ) => {
      const order = await h.orders.submit(h.userId, intent);
      expect(order.status).toBe('REJECTED');
      expect(order.failureReason).toBe(reason);
      expect(h.prisma.tradeLogs.at(-1)).toMatchObject({
        status: 'REJECTED',
        failureReason: reason,
      });
      expect(h.actions()).toContain('order.rejected');
      expect(h.prisma.auditLogs.at(-1)).toMatchObject({
        action: 'order.rejected',
        metadata: { reason },
      });
      expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
      return order;
    };

    it('robot arrêté (kill switch)', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      await h.control.activateKillSwitch(h.userId, {});
      await rejected(h, buy('BTC', 1), 'kill_switch');
      expect(await h.quantityOf('BTC')).toBe('0');
    });

    it('robot en pause (perte journalière)', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      h.prisma.users[0].botPausedUntil = new Date(Date.now() + 3_600_000);
      await rejected(h, buy('BTC', 1), 'paused_daily_loss');
    });

    it('le kill switch bloque aussi les ventes', async () => {
      const h = await buildOrders();
      await h.hold('BTC', 1);
      await h.control.activateKillSwitch(h.userId, {});
      await rejected(h, sell('BTC', 1), 'kill_switch');
    });

    it.each(['USDT', 'USDC', 'USD'])(
      'stablecoin %s non négociable',
      async (symbol) => {
        const h = await buildOrders();
        await h.fund(1000);
        await rejected(h, buy(symbol, 1), 'symbol_not_tradable');
      },
    );

    it('vente supérieure à la quantité détenue', async () => {
      const h = await buildOrders();
      await h.hold('BTC', 1);
      await rejected(h, sell('BTC', 1.5), 'insufficient_quantity');
      await rejected(h, sell('ETH', 1), 'insufficient_quantity');
    });

    it('prix indisponible', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      h.state.pricesDown = true;
      await rejected(h, buy('BTC', 1), 'price_unavailable');
      h.market.BTC = null;
      h.state.pricesDown = false;
      await rejected(h, buy('BTC', 1), 'price_unavailable');
    });

    it('capital non calculable : aucun ordre à l’aveugle', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      await h.hold('XYZ', 5); // sans prix : le capital total n'est pas calculable
      h.market.XYZ = null;
      await rejected(h, buy('BTC', 1), 'capital_unknown');
    });

    it('exposition maximale par position dépassée (5 % du capital par défaut)', async () => {
      const h = await buildOrders();
      await h.fund(10_000); // plafond : 500 $ par position
      await rejected(h, buy('BTC', 6), 'exposure_exceeded'); // 600 $
      const order = await h.orders.submit(h.userId, buy('BTC', 5)); // 500 $ : égalité autorisée
      expect(order.status).toBe('FILLED');
    });

    it('l’exposition compte la position déjà détenue', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      await h.hold('BTC', 4.5); // 450 $ déjà engagés (le capital passe à 10 450 $, plafond 522,5 $)
      await rejected(h, buy('BTC', 1), 'exposure_exceeded'); // 550 $ au total
    });

    it('un capital nul interdit tout achat', async () => {
      const h = await buildOrders();
      await rejected(h, buy('BTC', 1), 'insufficient_funds');
    });

    it('fonds insuffisants en PAPER (l’achat est payé avec l’USDT déclaré)', async () => {
      const h = await buildOrders();
      await h.fund(50);
      await h.hold('ETH', 10); // 30 000 $ : capital 30 050 $, exposition BTC autorisée jusqu'à 1 502 $
      await rejected(h, buy('BTC', 1), 'insufficient_funds'); // coût 100,1 $ pour 50 $ d'USDT
    });

    it('les frais comptent dans les fonds nécessaires', async () => {
      const h = await buildOrders();
      await h.fund(100); // pile le prix, sans les frais
      await h.hold('ETH', 10);
      await rejected(h, buy('BTC', 1), 'insufficient_funds');
    });

    it('ordre manuel refusé en mode LIVE (réservé aux signaux)', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      h.goLive();
      await rejected(h, buy('BTC', 1), 'manual_orders_paper_only');
    });

    it('un ordre issu d’un signal n’est pas concerné par la restriction manuelle', async () => {
      const h = await buildOrders({ dispatch: 'manual' });
      await h.fund(10_000);
      h.goLive();
      const order = await h.orders.submit(
        h.userId,
        buy('BTC', 1, { origin: OrderOrigin.SIGNAL }),
      );
      expect(order).toMatchObject({ status: 'PENDING', mode: 'LIVE' });
    });

    it('ne renvoie jamais le détail des garde-fous dans un secret (rien de sensible dans l’audit)', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      await h.orders.submit(h.userId, buy('BTC', 6));
      const logged = JSON.stringify(h.prisma.auditLogs);
      expect(logged).not.toMatch(/apiKey|apiSecret|SECRET|passwordHash/i);
    });
  });

  describe('consultation et annulation', () => {
    it('liste les ordres, les plus récents d’abord, avec limite, pagination et filtre', async () => {
      const h = await buildOrders();
      await h.fund(100_000);
      await h.orders.submit(h.userId, buy('BTC', 1));
      await h.orders.submit(h.userId, buy('BTC', 2));
      await h.orders.submit(h.userId, buy('BTC', 3000)); // refusé (exposition)

      const all = await h.orders.list(h.userId, { limit: 30 });
      expect(all.items.map((o) => o.quantity)).toEqual(['3000', '2', '1']);
      expect((await h.orders.list(h.userId, { limit: 2 })).items).toHaveLength(
        2,
      );
      expect(
        (
          await h.orders.list(h.userId, {
            limit: 30,
            before: all.items[1].createdAt,
          })
        ).items.map((o) => o.quantity),
      ).toEqual(['1']);
      expect(
        (await h.orders.list(h.userId, { limit: 30, status: 'REJECTED' }))
          .items,
      ).toHaveLength(1);
    });

    it('isole les utilisateurs', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      const order = await h.orders.submit(h.userId, buy('BTC', 1));

      expect((await h.orders.list('autre', { limit: 30 })).items).toEqual([]);
      await expect(h.orders.get('autre', order.id)).rejects.toThrow(
        NotFoundException,
      );
      await expect(h.orders.cancel('autre', order.id)).rejects.toThrow(
        NotFoundException,
      );
      await expect(h.orders.get(h.userId, order.id)).resolves.toMatchObject({
        id: order.id,
      });
    });

    it('annule un ordre pas encore pris en charge ; l’exécuteur ne le passe alors jamais', async () => {
      const h = await buildOrders({ dispatch: 'manual' });
      await h.fund(10_000);
      const order = await h.orders.submit(h.userId, buy('BTC', 1));

      await expect(h.orders.cancel(h.userId, order.id)).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      expect(h.actions()).toContain('order.cancelled');

      await h.executor.execute(order.id);
      expect(h.prisma.tradeLogs[0].status).toBe('CANCELLED');
      expect(await h.quantityOf('BTC')).toBe('0');
    });

    it('refuse d’annuler un ordre déjà exécuté ou refusé', async () => {
      const h = await buildOrders();
      await h.fund(10_000);
      const filled = await h.orders.submit(h.userId, buy('BTC', 1));
      const rejected = await h.orders.submit(h.userId, buy('BTC', 600));
      await expect(h.orders.cancel(h.userId, filled.id)).rejects.toThrow(
        ConflictException,
      );
      await expect(h.orders.cancel(h.userId, rejected.id)).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
