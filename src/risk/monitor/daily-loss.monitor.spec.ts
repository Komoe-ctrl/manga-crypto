import { FakePrisma } from '../../../test/support/fake-prisma.js';
import { AuditService } from '../../audit/audit.service.js';
import type { NotificationService } from '../../notifications/notification.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { TransactionSide } from '../../portfolio/dto/portfolio.dto.js';
import { PortfolioService } from '../../portfolio/portfolio.service.js';
import { PriceUnavailableError } from '../../portfolio/price/price-provider.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DailyLossMonitor } from './daily-loss.monitor.js';

const NOW = new Date('2026-10-23T10:00:00Z');
const DAY = 24 * 3_600_000;

async function build(timezone = 'UTC') {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const audit = new AuditService(asPrisma);
  const portfolio = new PortfolioService(asPrisma, audit);

  const market: Record<string, number | null> = { BTC: 100, ETH: 10 };
  let down = false;
  const provider = {
    getPriceAt: vi.fn(async () => null),
    getPrices: vi.fn(async (symbols: string[]) => {
      if (down) throw new PriceUnavailableError();
      return new Map(
        symbols.map((s) => [
          s,
          market[s] == null ? null : new Prisma.Decimal(market[s]),
        ]),
      );
    }),
  };
  const notifications = {
    notify: vi.fn(async (_userId: string, _input: object, _now?: Date) => null),
  };
  const user = await prisma.user.create({
    data: { email: 'a@example.com', passwordHash: 'x', timezone },
    select: { id: true },
  });
  const userId = user.id as string;

  return {
    prisma,
    userId,
    market,
    provider,
    setDown: (value: boolean) => (down = value),
    notifications,
    monitor: new DailyLossMonitor(
      asPrisma,
      portfolio,
      provider,
      audit,
      notifications as unknown as NotificationService,
    ),
    declare: (
      symbol: string,
      side: TransactionSide,
      quantity: string,
      price = '100',
    ) =>
      portfolio.recordTransaction(
        userId,
        { symbol, side, quantity, price },
        {},
      ),
  };
}

describe('DailyLossMonitor', () => {
  it('ne surveille rien sans position', async () => {
    const { monitor, userId, prisma } = await build();
    await expect(monitor.checkUser(userId, NOW)).resolves.toBe('no_holdings');
    expect(prisma.equitySnapshots).toHaveLength(0);
  });

  it("enregistre l'instantané d'ouverture à la première observation du jour local", async () => {
    const { monitor, userId, prisma, declare } = await build();
    await declare('BTC', TransactionSide.BUY, '2');

    await expect(monitor.checkUser(userId, NOW)).resolves.toBe(
      'baseline_created',
    );

    expect(prisma.equitySnapshots).toHaveLength(1);
    expect(prisma.equitySnapshots[0]).toMatchObject({
      userId,
      localDate: '2026-10-23',
      holdings: [{ symbol: 'BTC', quantity: '2', price: '100' }],
    });
    expect(prisma.equitySnapshots[0].equity.toFixed()).toBe('200');
  });

  it('ne fait rien tant que la perte reste sous le seuil', async () => {
    const { monitor, userId, market, declare, prisma } = await build();
    await declare('BTC', TransactionSide.BUY, '2');
    await monitor.checkUser(userId, NOW);

    market.BTC = 97.01; // −2,99 % pour un seuil de 3 %
    await expect(monitor.checkUser(userId, NOW)).resolves.toBe('ok');
    expect(prisma.users[0].botPausedUntil).toBeNull();
  });

  it('met le robot en pause jusqu’au prochain minuit local quand le seuil est atteint, et audite', async () => {
    const { monitor, userId, market, declare, prisma } = await build();
    await declare('BTC', TransactionSide.BUY, '2');
    await monitor.checkUser(userId, NOW);

    market.BTC = 97; // −3 % exactement
    await expect(monitor.checkUser(userId, NOW)).resolves.toBe('paused');

    expect(prisma.users[0].botPausedUntil).toEqual(
      new Date('2026-10-24T00:00:00Z'),
    );
    expect(prisma.auditLogs.at(-1)).toMatchObject({
      action: 'risk.daily_loss_paused',
      userId,
      metadata: {
        localDate: '2026-10-23',
        openEquity: '200',
        currentValue: '194',
        lossPct: '3',
        maxDailyLossPct: '3',
        pausedUntil: '2026-10-24T00:00:00.000Z',
      },
    });
  });

  describe('alerte critique', () => {
    async function paused() {
      const ctx = await build();
      await ctx.declare('BTC', TransactionSide.BUY, '2');
      await ctx.monitor.checkUser(ctx.userId, NOW);
      ctx.market.BTC = 90;
      return ctx;
    }

    it('envoie une notification critique avec une clé de déduplication par jour local', async () => {
      const { monitor, userId, notifications } = await paused();
      await monitor.checkUser(userId, NOW);

      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          title: 'Perte journalière maximale atteinte',
          critical: true,
          dedupeKey: 'daily-loss:2026-10-23',
          body: expect.stringContaining('10 %'),
        }),
        NOW,
      );
    });

    it("n'envoie rien tant que le seuil n'est pas atteint, ni quand la pause est déjà active", async () => {
      const { monitor, userId, notifications, market } = await build().then(
        async (ctx) => {
          await ctx.declare('BTC', TransactionSide.BUY, '2');
          await ctx.monitor.checkUser(ctx.userId, NOW);
          return ctx;
        },
      );
      market.BTC = 99;
      await monitor.checkUser(userId, NOW);
      expect(notifications.notify).not.toHaveBeenCalled();

      market.BTC = 90;
      await monitor.checkUser(userId, NOW);
      await monitor.checkUser(userId, NOW);
      expect(notifications.notify).toHaveBeenCalledTimes(1);
    });

    it("ne défait pas la pause quand l'envoi échoue", async () => {
      const { monitor, userId, notifications, prisma } = await paused();
      notifications.notify.mockRejectedValue(new Error('canal en panne'));

      await expect(monitor.checkUser(userId, NOW)).resolves.toBe('paused');
      expect(prisma.users[0].botPausedUntil).not.toBeNull();
      expect(prisma.auditLogs.at(-1)?.action).toBe('risk.daily_loss_paused');
    });
  });

  it('pause jusqu’au minuit du fuseau de l’utilisateur', async () => {
    const { monitor, userId, market, declare, prisma } =
      await build('Europe/Paris');
    await declare('BTC', TransactionSide.BUY, '2');
    await monitor.checkUser(userId, NOW);
    market.BTC = 90;
    await monitor.checkUser(userId, NOW);
    // Minuit à Paris (UTC+2 en octobre) = 22:00 UTC la veille.
    expect(prisma.users[0].botPausedUntil).toEqual(
      new Date('2026-10-23T22:00:00Z'),
    );
  });

  it('ne re-déclenche pas (ni ne ré-audite) quand la pause est déjà active', async () => {
    const { monitor, userId, market, declare, prisma } = await build();
    await declare('BTC', TransactionSide.BUY, '2');
    await monitor.checkUser(userId, NOW);
    market.BTC = 90;
    await monitor.checkUser(userId, NOW);
    const until = prisma.users[0].botPausedUntil;

    await expect(
      monitor.checkUser(userId, new Date(NOW.getTime() + 3_600_000)),
    ).resolves.toBe('already_paused');
    expect(prisma.users[0].botPausedUntil).toBe(until);
    expect(
      prisma.auditLogs.filter((l) => l.action === 'risk.daily_loss_paused'),
    ).toHaveLength(1);
  });

  it('ne déclenche pas sur un gain', async () => {
    const { monitor, userId, market, declare, prisma } = await build();
    await declare('BTC', TransactionSide.BUY, '2');
    await monitor.checkUser(userId, NOW);
    market.BTC = 150;
    await expect(monitor.checkUser(userId, NOW)).resolves.toBe('ok');
    expect(prisma.users[0].botPausedUntil).toBeNull();
  });

  it('applique le seuil de l’utilisateur', async () => {
    const { monitor, userId, market, declare, prisma } = await build();
    prisma.riskSettingsRows[0].maxDailyLossPct = new Prisma.Decimal(10);
    await declare('BTC', TransactionSide.BUY, '2');
    await monitor.checkUser(userId, NOW);

    market.BTC = 91; // −9 %
    await expect(monitor.checkUser(userId, NOW)).resolves.toBe('ok');
    market.BTC = 90; // −10 %
    await expect(monitor.checkUser(userId, NOW)).resolves.toBe('paused');
  });

  describe('prix incomplets', () => {
    it("ne crée pas d'instantané et ne conclut pas si la source de prix est injoignable", async () => {
      const { monitor, userId, declare, setDown, prisma } = await build();
      await declare('BTC', TransactionSide.BUY, '2');
      setDown(true);
      await expect(monitor.checkUser(userId, NOW)).resolves.toBe('no_prices');
      expect(prisma.equitySnapshots).toHaveLength(0);
    });

    it("ne crée pas d'instantané partiel si un prix manque", async () => {
      const { monitor, userId, declare, market, prisma } = await build();
      market.XYZ = null;
      await declare('BTC', TransactionSide.BUY, '1');
      await declare('XYZ', TransactionSide.BUY, '1');
      await expect(monitor.checkUser(userId, NOW)).resolves.toBe('no_prices');
      expect(prisma.equitySnapshots).toHaveLength(0);
    });

    it('ne déclenche pas de pause quand un prix manque après l’ouverture', async () => {
      const { monitor, userId, declare, market, prisma } = await build();
      await declare('BTC', TransactionSide.BUY, '2');
      await monitor.checkUser(userId, NOW);
      market.BTC = null;
      await expect(monitor.checkUser(userId, NOW)).resolves.toBe('no_prices');
      expect(prisma.users[0].botPausedUntil).toBeNull();
    });
  });

  describe('achats et ventes déclarés dans la journée', () => {
    it("ne faussent pas la perte : seule la variation de marché des positions d'ouverture compte", async () => {
      const { monitor, userId, declare, prisma } = await build();
      await declare('BTC', TransactionSide.BUY, '2');
      await monitor.checkUser(userId, NOW); // ouverture : 2 BTC à 100

      // L'utilisateur vend la moitié (retrait de fonds) : la valeur du portefeuille chute de 50 %…
      await declare('BTC', TransactionSide.SELL, '1');
      // …mais ce n'est pas une perte de marché : aucune pause.
      await expect(monitor.checkUser(userId, NOW)).resolves.toBe('ok');
      expect(prisma.users[0].botPausedUntil).toBeNull();
    });

    it('continue de valoriser une position vendue depuis l’ouverture', async () => {
      const { monitor, userId, declare, market, provider, prisma } =
        await build();
      await declare('BTC', TransactionSide.BUY, '2');
      await monitor.checkUser(userId, NOW);

      await declare('BTC', TransactionSide.SELL, '2'); // tout vendu
      await declare('ETH', TransactionSide.BUY, '5'); // autre position
      market.BTC = 90; // −10 % sur les positions d'ouverture

      await expect(monitor.checkUser(userId, NOW)).resolves.toBe('paused');
      expect(provider.getPrices).toHaveBeenLastCalledWith(
        expect.arrayContaining(['BTC', 'ETH']),
      );
      expect(prisma.users[0].botPausedUntil).not.toBeNull();
    });
  });

  describe('changement de jour', () => {
    it('prend un nouvel instantané le jour suivant, sans pause héritée de la veille', async () => {
      const { monitor, userId, market, declare, prisma } = await build();
      await declare('BTC', TransactionSide.BUY, '2');
      await monitor.checkUser(userId, NOW);
      market.BTC = 90;
      await monitor.checkUser(userId, NOW); // pause jusqu'au minuit

      const tomorrow = new Date(NOW.getTime() + DAY);
      await expect(monitor.checkUser(userId, tomorrow)).resolves.toBe(
        'baseline_created',
      );
      expect(prisma.equitySnapshots.map((s) => s.localDate)).toEqual([
        '2026-10-23',
        '2026-10-24',
      ]);
      // Nouvelle base : la baisse d'hier ne compte plus.
      await expect(monitor.checkUser(userId, tomorrow)).resolves.toBe('ok');
    });

    it('utilise le jour local de l’utilisateur', async () => {
      const { monitor, userId, declare, prisma } =
        await build('Pacific/Kiritimati');
      await declare('BTC', TransactionSide.BUY, '1');
      await monitor.checkUser(userId, new Date('2026-10-23T12:00:00Z'));
      expect(prisma.equitySnapshots[0].localDate).toBe('2026-10-24');
    });
  });

  it('ignore un utilisateur introuvable ou désactivé', async () => {
    const { monitor, userId, prisma, declare } = await build();
    await declare('BTC', TransactionSide.BUY, '1');
    await expect(monitor.checkUser('inconnu', NOW)).resolves.toBe('skipped');
    prisma.users[0].deletedAt = new Date();
    await expect(monitor.checkUser(userId, NOW)).resolves.toBe('skipped');
  });

  it("tolère une création simultanée de l'instantané (contrainte unique)", async () => {
    const { monitor, userId, prisma, declare } = await build();
    await declare('BTC', TransactionSide.BUY, '1');
    vi.spyOn(prisma.equitySnapshot, 'create').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(monitor.checkUser(userId, NOW)).resolves.toBe(
      'baseline_created',
    );
  });
});
