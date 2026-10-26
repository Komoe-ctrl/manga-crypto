import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuditService } from '../audit/audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { NotificationService } from '../notifications/notification.service.js';
import { TransactionSide } from '../portfolio/dto/portfolio.dto.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';
import { PriceUnavailableError } from '../portfolio/price/price-provider.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  CATCHUP_MINUTES,
  DigestGenerator,
  PRICE_RETRY_MINUTES,
} from './digest.generator.js';

const D = (value: number) => new Prisma.Decimal(value);
const at = (iso: string) => new Date(iso);

/** Vendredi 23/10/2026, 08:05 UTC : 5 minutes après l'heure du rapport (08:00) d'un utilisateur UTC. */
const FRIDAY = at('2026-10-23T08:05:00Z');
/** Lundi 26/10/2026. */
const MONDAY = at('2026-10-26T08:05:00Z');

type Market = Record<string, number | null>;

async function build(timezone = 'UTC') {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const portfolio = new PortfolioService(asPrisma, new AuditService(asPrisma));
  const user = await prisma.user.create({
    data: { email: 'a@example.com', passwordHash: 'x', timezone },
    select: { id: true },
  });
  const userId = user.id as string;

  const state = {
    now: { BTC: 110, ETH: 3000 } as Market,
    past: { BTC: 100, ETH: 3000 } as Market,
    down: false,
  };
  const provider = {
    getPrices: vi.fn(async (symbols: string[]) => {
      if (state.down) throw new PriceUnavailableError();
      return new Map(
        symbols.map((s) => [s, state.now[s] == null ? null : D(state.now[s]!)]),
      );
    }),
    getHourlyCloses: vi.fn(async () => null),
    getPriceAt: vi.fn(async (symbol: string, _at: Date) => {
      if (state.down) throw new PriceUnavailableError();
      return state.past[symbol] == null ? null : D(state.past[symbol]!);
    }),
  };
  const notifications = {
    notify: vi.fn(async (_userId: string, _input: object) => null),
  };
  const generator = new DigestGenerator(
    asPrisma,
    portfolio,
    provider,
    notifications as unknown as NotificationService,
  );

  return {
    prisma,
    userId,
    state,
    provider,
    notifications,
    generator,
    settings: prisma.notificationSettingsRows[0],
    hold: (symbol: string, quantity: string) =>
      portfolio.recordTransaction(
        userId,
        { symbol, side: TransactionSide.BUY, quantity, price: '1' },
        {},
      ),
    notification: (over: Record<string, unknown>) =>
      prisma.notification.create({
        data: {
          userId,
          title: 'Alerte',
          body: '-',
          critical: false,
          status: 'DISPATCHED',
          ...over,
        },
      }),
  };
}

describe('DigestGenerator', () => {
  describe('quand générer', () => {
    it("n'agit pas avant l'heure du rapport, ni après la fenêtre de rattrapage", async () => {
      const { generator, userId, prisma } = await build();
      await expect(
        generator.checkUser(userId, at('2026-10-23T07:59:00Z')),
      ).resolves.toBe('not_due');
      const tooLate = new Date(
        at('2026-10-23T08:00:00Z').getTime() + CATCHUP_MINUTES * 60_000,
      );
      await expect(generator.checkUser(userId, tooLate)).resolves.toBe(
        'not_due',
      );
      expect(prisma.digestReports).toHaveLength(0);
    });

    it("génère dès l'heure du rapport, et encore dans la fenêtre de rattrapage", async () => {
      const early = await build();
      await expect(
        early.generator.checkUser(early.userId, at('2026-10-23T08:00:00Z')),
      ).resolves.toBe('generated');

      const late = await build();
      const lastMinute = new Date(
        at('2026-10-23T08:00:00Z').getTime() + (CATCHUP_MINUTES - 1) * 60_000,
      );
      await expect(
        late.generator.checkUser(late.userId, lastMinute),
      ).resolves.toBe('generated');
    });

    it('respecte l’heure choisie et le fuseau de l’utilisateur', async () => {
      // 08:00 à Paris (UTC+2 en octobre) = 06:00 UTC.
      const { generator, userId, prisma } = await build('Europe/Paris');
      await expect(
        generator.checkUser(userId, at('2026-10-23T05:59:00Z')),
      ).resolves.toBe('not_due');
      await expect(
        generator.checkUser(userId, at('2026-10-23T06:05:00Z')),
      ).resolves.toBe('generated');
      expect(prisma.digestReports[0].periodStart).toEqual(
        at('2026-10-22T22:00:00Z'),
      ); // minuit à Paris
    });

    it('respecte un autre horaire (digestMinute) et la désactivation', async () => {
      const { generator, userId, settings } = await build();
      settings.digestMinute = 600; // 10:00
      await expect(generator.checkUser(userId, FRIDAY)).resolves.toBe(
        'not_due',
      );
      await expect(
        generator.checkUser(userId, at('2026-10-23T10:05:00Z')),
      ).resolves.toBe('generated');

      settings.digestEnabled = false;
      await expect(
        generator.checkUser(userId, at('2026-10-24T10:05:00Z')),
      ).resolves.toBe('disabled');
    });

    it('ignore un utilisateur introuvable ou désactivé', async () => {
      const { generator, userId, prisma } = await build();
      await expect(generator.checkUser('inconnu', FRIDAY)).resolves.toBe(
        'skipped',
      );
      prisma.users[0].deletedAt = new Date();
      await expect(generator.checkUser(userId, FRIDAY)).resolves.toBe(
        'skipped',
      );
    });
  });

  describe('contenu et enregistrement', () => {
    it('enregistre le rapport du jour avec sa période, son texte et sa variation', async () => {
      const { generator, userId, prisma, hold } = await build();
      await hold('BTC', '1'); // 100 → 110 : +10 %

      await generator.checkUser(userId, FRIDAY);

      expect(prisma.digestReports).toHaveLength(1);
      const report = prisma.digestReports[0];
      expect(report).toMatchObject({
        userId,
        period: 'TODAY',
        periodStart: at('2026-10-23T00:00:00Z'),
        periodEnd: FRIDAY,
        readAt: null,
        queuedAlertsCount: 0,
      });
      expect(report.summary).toContain(
        "Votre portefeuille a progressé d'environ 10 % sur 24 h.",
      );
      expect(report.points).toEqual([
        'Valeur du portefeuille : 110 $',
        'Plus forte hausse : BTC +10 %',
      ]);
      expect(report.portfolioDeltaPct.toFixed()).toBe('10');
    });

    it("valorise les positions actuelles aux prix d'il y a 24 h", async () => {
      const { generator, userId, hold, provider } = await build();
      await hold('BTC', '1');
      await generator.checkUser(userId, FRIDAY);
      expect(provider.getPriceAt).toHaveBeenCalledWith(
        'BTC',
        at('2026-10-22T08:05:00Z'),
      );
    });

    it('reprend les notifications mises en attente et les marque comme reprises', async () => {
      const { generator, userId, prisma, notification } = await build();
      const a = await notification({
        title: 'BTC −5 % en 1 h',
        status: 'HELD',
      });
      const b = await notification({
        title: 'ETH franchit 3 500 $ à la hausse',
        status: 'HELD',
      });
      const sent = await notification({ title: 'Déjà envoyée' });

      await generator.checkUser(userId, FRIDAY);

      const report = prisma.digestReports[0];
      expect(report.queuedAlertsCount).toBe(2);
      expect(report.points).toEqual([
        'Regroupée : BTC −5 % en 1 h',
        'Regroupée : ETH franchit 3 500 $ à la hausse',
      ]);
      for (const { id } of [a, b]) {
        expect(prisma.notifications.find((n) => n.id === id)).toMatchObject({
          status: 'DIGESTED',
          digestId: report.id,
        });
      }
      const untouched = prisma.notifications.find((n) => n.id === sent.id)!;
      expect(untouched.status).toBe('DISPATCHED');
      expect(untouched.digestId).toBeUndefined();
    });

    it('ne marque pas une notification arrivée pendant la génération (seules celles lues sont reprises)', async () => {
      const { generator, userId, prisma, notification } = await build();
      await notification({ title: 'Lue', status: 'HELD' });
      const original = prisma.digestReport.create;
      vi.spyOn(prisma.digestReport, 'create').mockImplementation(
        async (args: Parameters<typeof original>[0]) => {
          await notification({
            title: 'Arrivée en cours de route',
            status: 'HELD',
          });
          return original(args);
        },
      );

      await generator.checkUser(userId, FRIDAY);

      const states = Object.fromEntries(
        prisma.notifications.map((n) => [n.title, n.status]),
      );
      expect(states).toEqual({
        Lue: 'DIGESTED',
        'Arrivée en cours de route': 'HELD',
      });
    });

    it('compte les alertes critiques des dernières 24 h seulement', async () => {
      const { generator, userId, prisma, notification } = await build();
      await notification({
        title: 'Perte journalière maximale atteinte',
        critical: true,
      });
      prisma.notifications[0].createdAt = at('2026-10-23T06:00:00Z'); // 2 h plus tôt
      await notification({ title: 'Ancienne', critical: true });
      prisma.notifications[1].createdAt = at('2026-10-21T08:00:00Z'); // 2 jours plus tôt

      await generator.checkUser(userId, FRIDAY);

      const report = prisma.digestReports[0];
      expect(report.summary).toContain("Une alerte critique s'est déclenchée.");
      expect(report.points).toContain(
        'Critique : Perte journalière maximale atteinte',
      );
      expect(report.points).not.toContain('Critique : Ancienne');
    });

    it('un portefeuille vide donne un rapport sans chiffres', async () => {
      const { generator, userId, prisma, provider } = await build();
      await generator.checkUser(userId, FRIDAY);
      expect(prisma.digestReports[0]).toMatchObject({
        portfolioDeltaPct: null,
        points: [],
      });
      expect(prisma.digestReports[0].summary).toBe(
        "Nuit calme. Aucune alerte critique ne s'est déclenchée. Aucune action requise.",
      );
      expect(provider.getPrices).not.toHaveBeenCalled();
    });
  });

  describe('idempotence', () => {
    it('ne génère qu’un rapport par jour local et ne renvoie rien une seconde fois', async () => {
      const { generator, userId, prisma, notifications } = await build();
      await expect(generator.checkUser(userId, FRIDAY)).resolves.toBe(
        'generated',
      );
      await expect(
        generator.checkUser(userId, new Date(FRIDAY.getTime() + 300_000)),
      ).resolves.toBe('already_generated');
      expect(prisma.digestReports).toHaveLength(1);
      expect(notifications.notify).toHaveBeenCalledTimes(1);
    });

    it('génère un nouveau rapport le lendemain', async () => {
      const { generator, userId, prisma } = await build();
      await generator.checkUser(userId, FRIDAY);
      await expect(
        generator.checkUser(userId, at('2026-10-24T08:05:00Z')),
      ).resolves.toBe('generated');
      expect(
        prisma.digestReports.map((d) => d.periodStart.toISOString()),
      ).toEqual(['2026-10-23T00:00:00.000Z', '2026-10-24T00:00:00.000Z']);
    });

    it('deux passages simultanés ne créent qu’un rapport et ne notifient qu’une fois', async () => {
      const { generator, userId, prisma, notifications } = await build();
      await Promise.all([
        generator.checkUser(userId, FRIDAY),
        generator.checkUser(userId, FRIDAY),
      ]);
      expect(prisma.digestReports).toHaveLength(1);
      expect(notifications.notify).toHaveBeenCalledTimes(1);
    });
  });

  describe('rapport de la semaine', () => {
    it('est généré le lundi seulement, en plus du rapport du jour', async () => {
      const friday = await build();
      await friday.generator.checkUser(friday.userId, FRIDAY);
      expect(friday.prisma.digestReports.map((d) => d.period)).toEqual([
        'TODAY',
      ]);

      const monday = await build();
      await expect(
        monday.generator.checkUser(monday.userId, MONDAY),
      ).resolves.toBe('generated');
      expect(monday.prisma.digestReports.map((d) => d.period)).toEqual([
        'TODAY',
        'WEEK',
      ]);
    });

    it('couvre 7 jours et envoie son propre message', async () => {
      const { generator, userId, hold, provider, notifications } =
        await build();
      await hold('BTC', '1');
      await generator.checkUser(userId, MONDAY);

      expect(provider.getPriceAt).toHaveBeenCalledWith(
        'BTC',
        at('2026-10-19T08:05:00Z'),
      ); // 7 jours plus tôt
      expect(notifications.notify).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          title: 'Rapport de la semaine',
          dedupeKey: 'digest:WEEK:2026-10-26',
          immediate: true,
        }),
      );
    });

    it('ne reprend pas les notifications en attente (déjà prises par le rapport du jour)', async () => {
      const { generator, userId, prisma, notification } = await build();
      await notification({ title: 'En attente', status: 'HELD' });
      await generator.checkUser(userId, MONDAY);

      const [today, week] = prisma.digestReports;
      expect(today.queuedAlertsCount).toBe(1);
      expect(week.queuedAlertsCount).toBe(0);
      expect(week.points).not.toContain('Regroupée : En attente');
    });

    it('complète un lundi dont seul le rapport du jour existe', async () => {
      const { generator, userId, prisma } = await build();
      await generator.checkUser(userId, MONDAY);
      prisma.digestReports = prisma.digestReports.filter(
        (d) => d.period === 'TODAY',
      );

      await expect(
        generator.checkUser(userId, new Date(MONDAY.getTime() + 300_000)),
      ).resolves.toBe('generated');
      expect(prisma.digestReports.map((d) => d.period)).toEqual([
        'TODAY',
        'WEEK',
      ]);
    });
  });

  describe('prix indisponibles', () => {
    it('attend le tour suivant pendant la première heure, sans rien enregistrer', async () => {
      const { generator, userId, hold, state, prisma, notifications } =
        await build();
      await hold('BTC', '1');
      state.down = true;

      await expect(generator.checkUser(userId, FRIDAY)).resolves.toBe(
        'waiting_for_prices',
      );
      expect(prisma.digestReports).toHaveLength(0);
      expect(notifications.notify).not.toHaveBeenCalled();

      state.down = false;
      await expect(
        generator.checkUser(userId, new Date(FRIDAY.getTime() + 300_000)),
      ).resolves.toBe('generated');
    });

    it('passé la première heure, génère sans les chiffres du portefeuille plutôt que pas du tout', async () => {
      const { generator, userId, hold, state, prisma } = await build();
      await hold('BTC', '1');
      state.down = true;
      const later = new Date(
        at('2026-10-23T08:00:00Z').getTime() + PRICE_RETRY_MINUTES * 60_000,
      );

      await expect(generator.checkUser(userId, later)).resolves.toBe(
        'generated',
      );

      const report = prisma.digestReports[0];
      expect(report.portfolioDeltaPct).toBeNull();
      expect(report.summary).toContain(
        "La valeur du portefeuille n'a pas pu être calculée.",
      );
    });

    it('un prix passé manquant (actif pas coté) rend la variation non calculable', async () => {
      const { generator, userId, hold, state, prisma } = await build();
      await hold('BTC', '1');
      state.past.BTC = null;
      await generator.checkUser(userId, at('2026-10-23T09:30:00Z'));
      expect(prisma.digestReports[0].portfolioDeltaPct).toBeNull();
    });

    it('une position sans prix ne fausse pas le total : valeur non calculable', async () => {
      const { generator, userId, hold, state, prisma } = await build();
      await hold('BTC', '1');
      await hold('XYZ', '5');
      state.now.XYZ = null;
      await generator.checkUser(userId, at('2026-10-23T09:30:00Z'));
      expect(prisma.digestReports[0].summary).toContain(
        "n'a pas pu être calculée",
      );
    });
  });

  describe('annonce par notification', () => {
    it('envoie le rapport comme notification immédiate, hors Mode Nuit, avec une clé de déduplication', async () => {
      const { generator, userId, notifications, hold } = await build();
      await hold('BTC', '1');
      await generator.checkUser(userId, FRIDAY);

      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          title: 'Rapport du matin',
          immediate: true,
          dedupeKey: 'digest:TODAY:2026-10-23',
          body: expect.stringContaining(
            "Votre portefeuille a progressé d'environ 10 % sur 24 h.",
          ),
        }),
      );
      const body = (notifications.notify.mock.calls[0][1] as { body: string })
        .body;
      expect(body).toContain('• Valeur du portefeuille : 110 $');
    });

    it("conserve le rapport quand l'envoi échoue", async () => {
      const { generator, userId, notifications, prisma } = await build();
      notifications.notify.mockRejectedValue(new Error('canal en panne'));
      await expect(generator.checkUser(userId, FRIDAY)).resolves.toBe(
        'generated',
      );
      expect(prisma.digestReports).toHaveLength(1);
    });
  });

  describe('run (tous les utilisateurs)', () => {
    it('compte les rapports générés et isole l’échec d’un utilisateur', async () => {
      const { generator, prisma } = await build();
      await prisma.user.create({
        data: { email: 'b@example.com', passwordHash: 'x' },
        select: { id: true },
      });
      await prisma.user.create({
        data: { email: 'c@example.com', passwordHash: 'x' },
        select: { id: true },
      });

      const original = generator.checkUser.bind(generator);
      vi.spyOn(generator, 'checkUser').mockImplementation(async (id, now) => {
        if (id === prisma.users[1].id) throw new Error('boom');
        return original(id, now);
      });

      await expect(generator.run(FRIDAY)).resolves.toEqual({
        checked: 2,
        generated: 2,
        failed: 1,
      });
    });
  });
});
