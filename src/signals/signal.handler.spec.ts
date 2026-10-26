import { ConfigService } from '@nestjs/config';
import {
  buildOrders,
  type OrdersHarness,
} from '../../test/support/orders-harness.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SignalHandler } from './signal.handler.js';
import type { Signal } from './signal.schema.js';

const NOW = new Date('2026-10-24T08:01:00Z');

const signal = (over: Partial<Signal> = {}): Signal => ({
  v: 1,
  id: 'sig-1',
  ts: new Date('2026-10-24T08:00:00Z'), // 60 s avant NOW
  symbol: 'BTC',
  action: 'BUY',
  score: 0.8,
  price: '100',
  reason: 'EMA20 > EMA50',
  indicators: { rsi: 41 },
  ...over,
});

async function build(
  env: Record<string, string> = {},
  options: Parameters<typeof buildOrders>[0] = {},
) {
  const h = await buildOrders(options);
  const handler = new SignalHandler(
    new ConfigService(env),
    h.prisma as unknown as PrismaService,
    h.control,
    h.portfolio,
    h.valuation,
    h.provider,
    h.riskSettings,
    h.orders,
  );
  const handle = (s: Signal = signal(), entryId = '1729756860000-0') =>
    handler.handle(s, entryId, NOW);
  return { h, handler, handle };
}

const orders = (h: OrdersHarness) => h.prisma.tradeLogs;

describe('SignalHandler', () => {
  describe('achat', () => {
    it('achète la place disponible proportionnellement au score, par les garde-fous habituels', async () => {
      const { h, handle } = await build();
      await h.fund(10_000); // plafond : 500 $ = 5 BTC à 100 $

      const summary = await handle();

      expect(summary).toMatchObject({
        ignored: null,
        users: 1,
        outcomes: { submitted: 1 },
        failed: 0,
        retry: false,
      });
      expect(orders(h)).toHaveLength(1);
      expect(orders(h)[0]).toMatchObject({
        side: 'BUY',
        origin: 'SIGNAL',
        status: 'FILLED',
        mode: 'PAPER',
        symbol: 'BTC/USDT',
      });
      expect(orders(h)[0].quantity.toFixed()).toBe('4'); // 80 % de 5
      expect(await h.quantityOf('BTC')).toBe('4');
      // Stop-loss et take-profit programmés comme pour tout achat.
      expect(orders(h)[0].stopLossPrice.toFixed()).toBe('97');
    });

    it('garde l’identifiant et le contenu du signal sur l’ordre (traçabilité signal → ordre)', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await handle(signal({ id: 'sig-42' }), '1729756860000-7');

      expect(orders(h)[0].signalStreamId).toBe('sig-42');
      expect(orders(h)[0].signalPayload).toEqual({
        v: 1,
        id: 'sig-42',
        ts: '2026-10-24T08:00:00.000Z',
        symbol: 'BTC',
        action: 'BUY',
        score: 0.8,
        price: '100',
        reason: 'EMA20 > EMA50',
        indicators: { rsi: 41 },
        streamEntryId: '1729756860000-7',
      });
    });

    it('dimensionne selon le score', async () => {
      for (const [score, expected] of [
        [1, '5'],
        [0.6, '3'],
        [0.7, '3.5'],
      ] as const) {
        const { h, handle } = await build();
        await h.fund(10_000);
        await handle(signal({ score }));
        expect(orders(h)[0].quantity.toFixed()).toBe(expected);
      }
    });

    it('tient compte de la position déjà détenue', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await h.hold('BTC', 2); // capital 10 200 $ : plafond 510 $, place 310 $ → 80 % = 248 $
      await handle();
      expect(orders(h)[0].quantity.toFixed()).toBe('2.48');
    });

    it('n’achète pas quand la position est déjà au plafond', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await h.hold('BTC', 6);
      expect((await handle()).outcomes).toEqual({ no_capacity: 1 });
      expect(orders(h)).toHaveLength(0);
    });

    it('respecte le plafond d’exposition de l’utilisateur', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      h.prisma.riskSettingsRows[0].maxExposurePct = new (
        await import('../generated/prisma/client.js')
      ).Prisma.Decimal(10);
      await handle(signal({ score: 1 }));
      expect(orders(h)[0].quantity.toFixed()).toBe('10');
    });
  });

  describe('vente', () => {
    it('vend toute la position détenue du symbole', async () => {
      const { h, handle } = await build();
      await h.fund(1000);
      await h.hold('BTC', 3, 80);

      expect((await handle(signal({ action: 'SELL' }))).outcomes).toEqual({
        submitted: 1,
      });

      expect(orders(h)[0]).toMatchObject({
        side: 'SELL',
        origin: 'SIGNAL',
        status: 'FILLED',
      });
      expect(orders(h)[0].quantity.toFixed()).toBe('3');
      expect(await h.quantityOf('BTC')).toBe('0');
    });

    it('ne fait rien sans position', async () => {
      const { h, handle } = await build();
      await h.fund(1000);
      expect((await handle(signal({ action: 'SELL' }))).outcomes).toEqual({
        no_position: 1,
      });
      expect(orders(h)).toHaveLength(0);
    });

    it('n’est pas soumise à l’écart de prix (on ne bloque pas une sortie)', async () => {
      const { h, handle } = await build();
      await h.hold('BTC', 1);
      h.market.BTC = 130; // +30 % depuis l'analyse
      expect(
        (await handle(signal({ action: 'SELL', price: '100' }))).outcomes,
      ).toEqual({ submitted: 1 });
    });
  });

  describe('signaux ignorés pour tout le monde (aucun utilisateur lu)', () => {
    it.each([
      ['HOLD', signal({ action: 'HOLD' }), 'hold'],
      ['score sous le seuil', signal({ score: 0.59 }), 'below_min_score'],
      ['stablecoin', signal({ symbol: 'USDT' }), 'symbol_not_tradable'],
      [
        'périmé (plus de 5 minutes)',
        signal({ ts: new Date('2026-10-24T07:55:59Z') }),
        'stale',
      ],
    ] as const)('%s', async (_name, s, ignored) => {
      const { h, handle } = await build();
      await h.fund(10_000);
      expect(await handle(s)).toMatchObject({
        ignored,
        users: 0,
        retry: false,
      });
      expect(orders(h)).toHaveLength(0);
    });

    it('un signal de 5 minutes pile n’est pas encore périmé', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      expect(
        (await handle(signal({ ts: new Date('2026-10-24T07:56:00Z') })))
          .ignored,
      ).toBeNull();
    });
  });

  describe('réglages par variables d’environnement', () => {
    it('seuil de score, péremption et écart de prix configurables', async () => {
      const { h, handle } = await build({
        SIGNAL_MIN_SCORE: '0.9',
        SIGNAL_MAX_AGE_SECONDS: '30',
        SIGNAL_MAX_PRICE_DRIFT_PCT: '1',
      });
      await h.fund(10_000);
      const fresh = new Date('2026-10-24T08:00:45Z'); // 15 s avant NOW : dans les 30 s autorisées
      expect((await handle(signal({ score: 0.85, ts: fresh }))).ignored).toBe(
        'below_min_score',
      );
      expect((await handle(signal({ score: 0.95 }))).ignored).toBe('stale'); // 60 s > 30 s
      expect(
        (
          await handle(
            signal({ score: 0.95, ts: new Date('2026-10-24T08:00:45Z') }),
          )
        ).ignored,
      ).toBeNull();
      h.market.BTC = 101.5; // +1,5 % > 1 %
      expect(
        (
          await handle(
            signal({
              id: 's2',
              score: 0.95,
              ts: new Date('2026-10-24T08:00:45Z'),
            }),
          )
        ).outcomes,
      ).toEqual({ price_drift: 1 });
    });

    it.each([['abc'], ['-1'], ['2'], ['']])(
      'une valeur invalide (%j) de SIGNAL_MIN_SCORE donne le défaut 0,6',
      async (value) => {
        const { h, handle } = await build({ SIGNAL_MIN_SCORE: value });
        await h.fund(10_000);
        expect((await handle(signal({ score: 0.59 }))).ignored).toBe(
          'below_min_score',
        );
        expect(
          (await handle(signal({ id: 's2', score: 0.6 }))).outcomes,
        ).toEqual({ submitted: 1 });
      },
    );
  });

  describe('déduplication : un signal ne passe jamais deux fois un ordre', () => {
    it('un signal retraité (reprise, republication) est ignoré', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await handle();
      const again = await handle(signal(), '1729756860000-1'); // même id, autre entrée du stream

      expect(again.outcomes).toEqual({ duplicate: 1 });
      expect(orders(h)).toHaveLength(1);
      expect(await h.quantityOf('BTC')).toBe('4');
    });

    it('deux traitements simultanés du même signal ne passent qu’un seul ordre (contrainte unique en base)', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);

      // Les deux passages lisent « pas encore d'ordre » : seule la contrainte unique les départage.
      const [a, b] = await Promise.all([handle(), handle()]);

      expect(orders(h)).toHaveLength(1);
      expect(await h.quantityOf('BTC')).toBe('4'); // pas 8 : la position n'est pas doublée
      const outcomes = [a.outcomes, b.outcomes];
      expect(outcomes).toContainEqual({ submitted: 1 });
      expect(outcomes).toContainEqual({ duplicate: 1 });
    });

    it('le même signal reste distinct d’un utilisateur à l’autre', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      const user = await h.prisma.user.create({
        data: { email: 'b@example.com', passwordHash: 'x' },
        select: { id: true },
      });
      await h.portfolio.setAsset(
        user.id,
        'USDT',
        { quantity: '10000', avgBuyPrice: '1' },
        {},
      );

      expect((await handle()).outcomes).toEqual({ submitted: 2 });
      expect(orders(h).map((o) => o.signalStreamId)).toEqual([
        'sig-1',
        'sig-1',
      ]);
    });

    it('un autre signal est traité normalement', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await handle(signal({ id: 'a', score: 0.6 }));
      await handle(signal({ id: 'b', score: 0.6 }));
      expect(orders(h).map((o) => o.signalStreamId)).toEqual(['a', 'b']);
    });
  });

  describe('robot arrêté ou en pause', () => {
    it('kill switch : aucun ordre, rien d’enregistré (un signal n’est pas une intention de l’utilisateur)', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await h.control.activateKillSwitch(h.userId, {});
      expect((await handle()).outcomes).toEqual({ robot_blocked: 1 });
      expect(orders(h)).toHaveLength(0);
    });

    it('pause pour perte journalière : même traitement, vente comprise', async () => {
      const { h, handle } = await build();
      await h.hold('BTC', 1);
      // `control.status` compare à l'horloge réelle : la pause doit être dans le futur réel, pas par rapport à NOW.
      h.prisma.users[0].botPausedUntil = new Date(Date.now() + 3_600_000);
      expect((await handle(signal({ action: 'SELL' }))).outcomes).toEqual({
        robot_blocked: 1,
      });
      expect(orders(h)).toHaveLength(0);
    });

    it('le robot repart : le signal suivant est traité', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await h.control.activateKillSwitch(h.userId, {});
      await handle(signal({ id: 'a' }));
      await h.control.deactivateKillSwitch(h.userId, {});
      expect((await handle(signal({ id: 'b' }))).outcomes).toEqual({
        submitted: 1,
      });
    });
  });

  describe('données manquantes ou périmées', () => {
    it('source de prix injoignable : à retenter, aucun ordre', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      h.state.pricesDown = true;
      expect(await handle()).toMatchObject({
        outcomes: { price_unavailable: 1 },
        retry: true,
      });
      expect(orders(h)).toHaveLength(0);

      h.state.pricesDown = false;
      expect((await handle()).outcomes).toEqual({ submitted: 1 }); // le retraitement aboutit
    });

    it('symbole sans prix : à retenter', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      expect((await handle(signal({ symbol: 'NOPE' }))).retry).toBe(true);
    });

    it('le prix a trop bougé depuis l’analyse : achat ignoré (écart de 2 % toléré)', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      h.market.BTC = 102.01;
      expect((await handle(signal({ price: '100' }))).outcomes).toEqual({
        price_drift: 1,
      });
      expect(orders(h)).toHaveLength(0);

      h.market.BTC = 102;
      expect(
        (await handle(signal({ id: 's2', price: '100' }))).outcomes,
      ).toEqual({ submitted: 1 });
    });

    it('un signal sans prix n’est pas soumis à l’écart', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      h.market.BTC = 150;
      expect((await handle(signal({ price: null }))).outcomes).toEqual({
        submitted: 1,
      });
    });

    it('capital non calculable (un prix manque) : aucun achat à l’aveugle', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await h.hold('XYZ', 5);
      h.market.XYZ = null;
      expect((await handle()).outcomes).toEqual({ capital_unknown: 1 });
      expect(orders(h)).toHaveLength(0);
    });

    it('quantité arrondie à zéro : aucun ordre', async () => {
      const { h, handle } = await build();
      await h.fund('0.00001');
      expect((await handle(signal({ score: 1 }))).outcomes).toEqual({
        too_small: 1,
      });
    });
  });

  describe('garde-fous des ordres', () => {
    it('un ordre refusé (fonds insuffisants en PAPER) est enregistré avec son motif et compté « rejected »', async () => {
      const { h, handle } = await build();
      await h.hold('ETH', 10); // capital 30 000 $, mais aucun USDT
      expect((await handle()).outcomes).toEqual({ rejected: 1 });
      expect(orders(h)[0]).toMatchObject({
        status: 'REJECTED',
        failureReason: 'insufficient_funds',
        origin: 'SIGNAL',
        signalStreamId: 'sig-1',
      });
    });

    it('un signal ne contourne jamais les ordres : mode LIVE → ordre LIVE en attente d’exécution, pas de restriction manuelle', async () => {
      const { h, handle } = await build(
        { SIGNALS_ALLOW_LIVE: 'true' },
        { dispatch: 'manual' },
      );
      await h.fund(10_000);
      h.goLive();
      expect((await handle()).outcomes).toEqual({ submitted: 1 });
      expect(orders(h)[0]).toMatchObject({
        mode: 'LIVE',
        status: 'PENDING',
        origin: 'SIGNAL',
      });
      expect(h.gateway.findCalls).toBe(0); // rien n'est parti tant que l'exécuteur n'a pas pris l'ordre
    });
  });

  describe('verrou LIVE (SIGNALS_ALLOW_LIVE)', () => {
    it('par défaut, un signal ne passe jamais d’ordre pour un utilisateur en mode LIVE', async () => {
      const { h, handle } = await build({}, { dispatch: 'manual' });
      await h.fund(10_000);
      h.goLive();

      const summary = await handle();

      expect(summary.outcomes).toEqual({ live_not_allowed: 1 });
      expect(summary.retry).toBe(false); // ce n'est pas un incident : rien à retenter
      expect(orders(h)).toHaveLength(0); // et aucun ordre « refusé » n'est enregistré (ce serait du bruit)
    });

    it('le verrou vaut aussi pour une vente : on ne sort pas non plus sur signal en LIVE', async () => {
      const { h, handle } = await build({}, { dispatch: 'manual' });
      await h.fund(10_000);
      await h.hold('BTC', 1, 90); // une position à vendre
      h.goLive();
      const summary = await handle(signal({ action: 'SELL', id: 'sig-sell' }));
      expect(summary.outcomes).toEqual({ live_not_allowed: 1 });
      expect(orders(h)).toHaveLength(0);
    });

    it('avec SIGNALS_ALLOW_LIVE=true, le signal passe par les garde-fous habituels', async () => {
      const { h, handle } = await build(
        { SIGNALS_ALLOW_LIVE: 'true' },
        { dispatch: 'manual' },
      );
      await h.fund(10_000);
      h.goLive();
      expect((await handle()).outcomes).toEqual({ submitted: 1 });
      expect(orders(h)[0]).toMatchObject({ mode: 'LIVE', origin: 'SIGNAL' });
    });

    it.each(['yes', 'TRUE', 'True', '1', 'on', ' true', 'false', ''])(
      'seule la valeur exacte « true » active : %j reste verrouillé',
      async (value) => {
        const { h, handle } = await build(
          { SIGNALS_ALLOW_LIVE: value },
          { dispatch: 'manual' },
        );
        await h.fund(10_000);
        h.goLive();
        expect((await handle()).outcomes).toEqual({ live_not_allowed: 1 });
        expect(orders(h)).toHaveLength(0);
      },
    );

    it('le mode PAPER n’est pas concerné : le verrou ne gêne pas la simulation', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      expect((await handle()).outcomes).toEqual({ submitted: 1 });
      expect(orders(h)[0]).toMatchObject({ mode: 'PAPER' });
    });

    it('un utilisateur LIVE verrouillé ne gêne pas un utilisateur PAPER', async () => {
      const { h, handle } = await build({}, { dispatch: 'manual' });
      await h.fund(10_000);
      const paper = await h.prisma.user.create({
        data: { email: 'paper@example.com', passwordHash: 'x' },
        select: { id: true },
      });
      await h.portfolio.setAsset(
        paper.id,
        'USDT',
        { quantity: '10000', avgBuyPrice: '1' },
        {},
      );
      h.goLive(); // le premier utilisateur passe en LIVE

      const summary = await handle();

      expect(summary.outcomes).toEqual({ live_not_allowed: 1, submitted: 1 });
      expect(orders(h)).toHaveLength(1);
      expect(orders(h)[0]).toMatchObject({ mode: 'PAPER', userId: paper.id });
    });
  });

  describe('plusieurs utilisateurs', () => {
    const secondUser = async (h: OrdersHarness) => {
      const user = await h.prisma.user.create({
        data: { email: 'b@example.com', passwordHash: 'x' },
        select: { id: true },
      });
      await h.portfolio.setAsset(
        user.id,
        'USDT',
        { quantity: '10000', avgBuyPrice: '1' },
        {},
      );
      return user.id as string;
    };

    it('applique le signal à chaque utilisateur actif, chacun avec ses propres garde-fous', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      const other = await secondUser(h);
      await h.control.activateKillSwitch(other, {});

      const summary = await handle();

      expect(summary).toMatchObject({
        users: 2,
        outcomes: { submitted: 1, robot_blocked: 1 },
      });
      expect(orders(h).map((o) => o.userId)).toEqual([h.userId]);
    });

    it('ignore les utilisateurs désactivés', async () => {
      const { h, handle } = await build();
      await h.fund(10_000);
      await secondUser(h);
      h.prisma.users[1].deletedAt = new Date();
      expect((await handle()).users).toBe(1);
    });

    it('une erreur chez un utilisateur n’empêche pas les autres ; le retraitement ne sert que celui qui manque', async () => {
      const { h, handler } = await build();
      await h.fund(10_000);
      const other = await secondUser(h);
      const submit = vi
        .spyOn(h.orders, 'submit')
        .mockImplementationOnce(async () => {
          throw new Error('base indisponible');
        });

      const first = await handler.handle(signal(), '1-0', NOW);
      expect(first).toMatchObject({
        failed: 1,
        retry: true,
        outcomes: { submitted: 1 },
      });
      expect(orders(h).map((o) => o.userId)).toEqual([other]);

      submit.mockRestore();
      const second = await handler.handle(signal(), '1-0', NOW);
      expect(second.outcomes).toEqual({ duplicate: 1, submitted: 1 });
      expect(
        orders(h)
          .map((o) => o.userId)
          .sort(),
      ).toEqual([h.userId, other].sort());
    });
  });
});
