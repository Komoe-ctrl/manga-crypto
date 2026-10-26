import { FakePrisma } from '../../../test/support/fake-prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AlertCondition,
  NotificationChannel,
} from '../../generated/prisma/enums.js';
import { AuditService } from '../../audit/audit.service.js';
import { PortfolioService } from '../../portfolio/portfolio.service.js';
import { PriceUnavailableError } from '../../portfolio/price/price-provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { TransactionSide } from '../../portfolio/dto/portfolio.dto.js';
import type { NotificationService } from '../notification.service.js';
import { AlertEvaluator, MIN_RETRIGGER_MS } from './alert-evaluator.js';

const NOW = new Date('2026-10-23T12:00:00Z');
const D = (value: number) => new Prisma.Decimal(value);

type Market = Record<string, number | null>;

async function build() {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const portfolio = new PortfolioService(asPrisma, new AuditService(asPrisma));
  const user = await prisma.user.create({
    data: { email: 'a@example.com', passwordHash: 'x' },
    select: { id: true },
  });
  const userId = user.id as string;

  const state = {
    now: { BTC: 100, ETH: 3000 } as Market,
    past: { BTC: 100, ETH: 3000 } as Market,
    pricesDown: false,
    pastDown: false,
  };
  const provider = {
    getPrices: vi.fn(async (symbols: string[]) => {
      if (state.pricesDown) throw new PriceUnavailableError();
      return new Map(
        symbols.map((s) => [s, state.now[s] == null ? null : D(state.now[s]!)]),
      );
    }),
    getHourlyCloses: vi.fn(async () => null),
    getPriceAt: vi.fn(async (symbol: string, _at: Date) => {
      if (state.pastDown) throw new PriceUnavailableError();
      return state.past[symbol] == null ? null : D(state.past[symbol]!);
    }),
  };
  const notifications = {
    notify: vi.fn(async (_userId: string, _input: object) => null),
  };
  const evaluator = new AlertEvaluator(
    asPrisma,
    portfolio,
    provider,
    notifications as unknown as NotificationService,
  );

  const alert = (over: Record<string, unknown> = {}) =>
    prisma.alertConfig.create({
      data: {
        userId,
        assetSymbol: 'BTC',
        condition: AlertCondition.PRICE_CROSS_ABOVE,
        threshold: D(150),
        windowMinutes: null,
        channel: NotificationChannel.PUSH,
        isActive: true,
        isCritical: false,
        ...over,
      },
    });

  return {
    prisma,
    userId,
    state,
    provider,
    notifications,
    evaluator,
    alert,
    row: (index = 0) => prisma.alertConfigs[index],
    hold: (symbol: string, quantity: string) =>
      portfolio.recordTransaction(
        userId,
        { symbol, side: TransactionSide.BUY, quantity, price: '1' },
        {},
      ),
  };
}

describe('AlertEvaluator', () => {
  describe('franchissement de prix', () => {
    it('notifie au franchissement, sur le canal de l’alerte, et passe en « déclenchée »', async () => {
      const { evaluator, alert, state, notifications, row } = await build();
      await alert({ channel: NotificationChannel.TELEGRAM, isCritical: true });
      state.now.BTC = 160;

      const summary = await evaluator.run(NOW);

      expect(summary).toEqual({
        evaluated: 1,
        triggered: 1,
        rearmed: 0,
        skipped: 0,
        failed: 0,
      });
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          title: 'BTC franchit 150 $ à la hausse',
          critical: true,
          channel: 'TELEGRAM',
          dedupeKey: `alert:${row().id}:2026-10-23T12:00`,
        }),
      );
      expect(row()).toMatchObject({ isTriggered: true, lastTriggeredAt: NOW });
    });

    it('ne notifie pas tant que la condition reste vraie', async () => {
      const { evaluator, alert, state, notifications } = await build();
      await alert();
      state.now.BTC = 160;

      await evaluator.run(NOW);
      const again = await evaluator.run(new Date(NOW.getTime() + 60_000));

      expect(again).toMatchObject({ triggered: 0 });
      expect(notifications.notify).toHaveBeenCalledTimes(1);
    });

    it('ne notifie rien tant que le seuil n’est pas atteint', async () => {
      const { evaluator, alert, state, notifications, row } = await build();
      await alert();
      state.now.BTC = 149.99;
      await evaluator.run(NOW);
      expect(notifications.notify).not.toHaveBeenCalled();
      expect(row().isTriggered).toBe(false);
    });

    it('se ré-arme quand la condition redevient fausse, puis notifie à nouveau (après l’anti-rebond)', async () => {
      const { evaluator, alert, state, notifications, row } = await build();
      await alert();

      state.now.BTC = 160;
      await evaluator.run(NOW);
      state.now.BTC = 140;
      const rearm = await evaluator.run(new Date(NOW.getTime() + 60_000));
      expect(rearm).toMatchObject({ rearmed: 1 });
      expect(row().isTriggered).toBe(false);

      state.now.BTC = 170;
      await evaluator.run(new Date(NOW.getTime() + MIN_RETRIGGER_MS + 60_000));
      expect(notifications.notify).toHaveBeenCalledTimes(2);
      expect(row().isTriggered).toBe(true);
    });

    it('retient un nouveau franchissement trop proche (anti-rebond), sans le perdre', async () => {
      const { evaluator, alert, state, notifications, row } = await build();
      await alert();

      state.now.BTC = 160;
      await evaluator.run(NOW);
      state.now.BTC = 140;
      await evaluator.run(new Date(NOW.getTime() + 60_000)); // ré-armée
      state.now.BTC = 170;
      const soon = await evaluator.run(new Date(NOW.getTime() + 2 * 60_000)); // 2 min après : trop tôt

      expect(soon).toMatchObject({ triggered: 0 });
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(row().isTriggered).toBe(false); // toujours armée

      // Toujours vraie après le délai : elle notifie.
      await evaluator.run(new Date(NOW.getTime() + MIN_RETRIGGER_MS + 60_000));
      expect(notifications.notify).toHaveBeenCalledTimes(2);
    });

    it('franchissement à la baisse', async () => {
      const { evaluator, alert, state, notifications } = await build();
      await alert({
        condition: AlertCondition.PRICE_CROSS_BELOW,
        threshold: D(3000),
        assetSymbol: 'ETH',
      });
      state.now.ETH = 2990;
      await evaluator.run(NOW);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ title: 'ETH passe sous 3 000 $' }),
      );
    });
  });

  describe('variations sur une fenêtre', () => {
    it('baisse en % : compare au prix de l’instant (maintenant − fenêtre)', async () => {
      const { evaluator, alert, state, notifications, provider } =
        await build();
      await alert({
        condition: AlertCondition.PRICE_DROP_PCT,
        threshold: D(5),
        windowMinutes: 60,
      });
      state.past.BTC = 100;
      state.now.BTC = 94;

      await evaluator.run(NOW);

      expect(provider.getPriceAt).toHaveBeenCalledWith(
        'BTC',
        new Date('2026-10-23T11:00:00Z'),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          title: 'BTC −5 % en 1 h',
          body: expect.stringContaining('6 %'),
        }),
      );
    });

    it('hausse en %', async () => {
      const { evaluator, alert, state, notifications } = await build();
      await alert({
        condition: AlertCondition.PRICE_RISE_PCT,
        threshold: D(8),
        windowMinutes: 1440,
      });
      state.past.BTC = 100;
      state.now.BTC = 109;
      await evaluator.run(NOW);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ title: 'BTC +8 % sur 24 h' }),
      );
    });

    it('ne notifie pas une baisse insuffisante', async () => {
      const { evaluator, alert, state, notifications } = await build();
      await alert({
        condition: AlertCondition.PRICE_DROP_PCT,
        threshold: D(5),
        windowMinutes: 60,
      });
      state.now.BTC = 96;
      await evaluator.run(NOW);
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('partage le prix passé entre alertes du même symbole et de la même fenêtre', async () => {
      const { evaluator, alert, provider } = await build();
      await alert({
        condition: AlertCondition.PRICE_DROP_PCT,
        threshold: D(5),
        windowMinutes: 60,
      });
      await alert({
        condition: AlertCondition.PRICE_RISE_PCT,
        threshold: D(5),
        windowMinutes: 60,
      });
      await evaluator.run(NOW);
      expect(provider.getPriceAt).toHaveBeenCalledTimes(1);
    });
  });

  describe('baisse du portefeuille', () => {
    it('compare la valeur des positions actuelles aux prix passés et aux prix courants', async () => {
      const { evaluator, alert, state, notifications, hold } = await build();
      await hold('BTC', '1');
      await hold('ETH', '10');
      await alert({
        condition: AlertCondition.PORTFOLIO_DROP_PCT,
        assetSymbol: null,
        threshold: D(10),
        windowMinutes: 10080,
      });
      state.past = { BTC: 100, ETH: 3000 }; // 30 100
      state.now = { BTC: 90, ETH: 2700 }; //   27 090 → −10 %

      await evaluator.run(NOW);

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          title: 'Portefeuille −10 % sur 7 jours',
          body: expect.stringContaining('27 090 $'),
        }),
      );
    });

    it('ne conclut pas si un prix passé manque', async () => {
      const { evaluator, alert, state, notifications, hold, row } =
        await build();
      await hold('BTC', '1');
      await hold('ETH', '10');
      await alert({
        condition: AlertCondition.PORTFOLIO_DROP_PCT,
        assetSymbol: null,
        threshold: D(10),
        windowMinutes: 1440,
      });
      state.past.ETH = null;
      state.now = { BTC: 10, ETH: 100 };

      const summary = await evaluator.run(NOW);

      expect(summary).toMatchObject({ skipped: 1, triggered: 0 });
      expect(notifications.notify).not.toHaveBeenCalled();
      expect(row().isTriggered).toBe(false);
    });

    it('ne fait rien sans position', async () => {
      const { evaluator, alert, notifications } = await build();
      await alert({
        condition: AlertCondition.PORTFOLIO_DROP_PCT,
        assetSymbol: null,
        threshold: D(10),
        windowMinutes: 1440,
      });
      expect(await evaluator.run(NOW)).toMatchObject({ skipped: 1 });
      expect(notifications.notify).not.toHaveBeenCalled();
    });
  });

  describe('données manquantes : l’état ne change jamais', () => {
    it('source de prix injoignable : tout est ignoré', async () => {
      const { evaluator, alert, state, notifications, row } = await build();
      await alert();
      state.pricesDown = true;
      expect(await evaluator.run(NOW)).toMatchObject({
        skipped: 1,
        triggered: 0,
      });
      expect(notifications.notify).not.toHaveBeenCalled();
      expect(row().isTriggered).toBe(false);
    });

    it('ne ré-arme pas une alerte déclenchée quand les prix sont indisponibles', async () => {
      const { evaluator, alert, state, row } = await build();
      await alert();
      state.now.BTC = 160;
      await evaluator.run(NOW);

      state.pricesDown = true;
      await evaluator.run(new Date(NOW.getTime() + 60_000));
      expect(row().isTriggered).toBe(true);
    });

    it('historique indisponible : l’alerte de variation est ignorée, sans erreur', async () => {
      const { evaluator, alert, state } = await build();
      await alert({
        condition: AlertCondition.PRICE_DROP_PCT,
        threshold: D(5),
        windowMinutes: 60,
      });
      state.pastDown = true;
      expect(await evaluator.run(NOW)).toMatchObject({ skipped: 1, failed: 0 });
    });

    it('symbole sans prix : ignoré', async () => {
      const { evaluator, alert } = await build();
      await alert({ assetSymbol: 'XYZ' });
      expect(await evaluator.run(NOW)).toMatchObject({ skipped: 1 });
    });
  });

  describe('portée', () => {
    it('ignore les alertes inactives et celles d’un utilisateur désactivé', async () => {
      const { evaluator, alert, state, notifications, prisma } = await build();
      await alert({ isActive: false });
      await alert();
      state.now.BTC = 160;
      prisma.users[0].deletedAt = new Date();

      expect(await evaluator.run(NOW)).toMatchObject({ evaluated: 0 });
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('ne fait aucun appel de prix sans alerte', async () => {
      const { evaluator, provider } = await build();
      expect(await evaluator.run(NOW)).toMatchObject({ evaluated: 0 });
      expect(provider.getPrices).not.toHaveBeenCalled();
    });
  });

  describe('fiabilité', () => {
    it('rend l’état et signale l’échec si l’envoi lève une erreur, puis réessaie au passage suivant', async () => {
      const { evaluator, alert, state, notifications, row } = await build();
      await alert();
      state.now.BTC = 160;
      notifications.notify.mockRejectedValueOnce(
        new Error('base indisponible'),
      );

      const first = await evaluator.run(NOW);
      expect(first).toMatchObject({ failed: 1, triggered: 0 });
      expect(row()).toMatchObject({
        isTriggered: false,
        lastTriggeredAt: null,
      });

      const second = await evaluator.run(new Date(NOW.getTime() + 60_000));
      expect(second).toMatchObject({ triggered: 1 });
      expect(notifications.notify).toHaveBeenCalledTimes(2);
    });

    it('une alerte en erreur n’empêche pas les suivantes', async () => {
      const { evaluator, alert, state, notifications } = await build();
      await alert();
      await alert({ assetSymbol: 'ETH', threshold: D(2500) });
      state.now = { BTC: 160, ETH: 3000 };
      notifications.notify.mockRejectedValueOnce(new Error('boom'));

      expect(await evaluator.run(NOW)).toMatchObject({
        failed: 1,
        triggered: 1,
      });
    });

    it('deux évaluations simultanées ne notifient qu’une fois (prise d’état atomique)', async () => {
      const { evaluator, alert, state, notifications } = await build();
      await alert();
      state.now.BTC = 160;

      await Promise.all([evaluator.run(NOW), evaluator.run(NOW)]);

      expect(notifications.notify).toHaveBeenCalledTimes(1);
    });
  });
});
