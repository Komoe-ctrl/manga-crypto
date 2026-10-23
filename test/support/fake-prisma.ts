import { randomUUID } from 'node:crypto';
import { Prisma } from '../../src/generated/prisma/client.js';

type Row = Record<string, any>;

/**
 * Base en mémoire couvrant les appels Prisma utilisés par l'authentification.
 * Évite de polluer la base de dev (audit_logs est immuable) et garde les tests rapides.
 */
export class FakePrisma {
  users: Row[] = [];
  refreshTokens: Row[] = [];
  auditLogs: Row[] = [];

  user = {
    create: async ({ data, select }: Row) => {
      if (this.users.some((u) => u.email === data.email)) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: 'test',
          },
        );
      }
      const { notificationSettings: _n, riskSettings: _r, ...fields } = data;
      const row = {
        id: randomUUID(),
        displayName: null,
        timezone: 'Europe/Paris',
        baseCurrency: 'USD',
        tradingMode: 'PAPER',
        killSwitchActive: false,
        killSwitchAt: null,
        botPausedUntil: null,
        tradingModeChangedAt: null,
        deletedAt: null,
        ...Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined),
        ),
      };
      this.users.push(row);
      // Valeurs par défaut du schéma Prisma (NotificationSettings).
      this.notificationSettingsRows.push({
        userId: row.id,
        nightModeEnabled: true,
        nightStartMinute: 1320,
        nightEndMinute: 420,
        digestEnabled: true,
        digestMinute: 480,
        pushEnabled: true,
        telegramEnabled: false,
        emailEnabled: false,
        telegramChatId: null,
        notificationEmail: null,
      });
      // Valeurs par défaut du schéma Prisma (RiskSettings).
      this.riskSettingsRows.push({
        userId: row.id,
        maxExposurePct: new Prisma.Decimal(5),
        maxDailyLossPct: new Prisma.Decimal(3),
        defaultStopLossPct: new Prisma.Decimal(3),
        defaultTakeProfitPct: new Prisma.Decimal(6),
      });
      return pick(row, select);
    },
    findMany: async ({ where, select }: Row) =>
      this.users.filter((u) => matches(u, where)).map((u) => pick(u, select)),
    update: async ({ where, data, select }: Row) => {
      const row = this.users.find((u) => u.id === where.id)!;
      Object.assign(row, data);
      return pick(row, select);
    },
    findFirst: async ({ where, select }: Row) => {
      const row = this.users.find((u) => matches(u, where));
      return row ? pick(row, select) : null;
    },
  };

  refreshToken = {
    create: async ({ data }: Row) => {
      const row = {
        id: randomUUID(),
        revokedAt: null,
        createdAt: new Date(),
        ...data,
      };
      this.refreshTokens.push(row);
      return row;
    },
    findUnique: async ({ where }: Row) =>
      this.refreshTokens.find((t) => t.tokenHash === where.tokenHash) ?? null,
    updateMany: async ({ where, data }: Row) => {
      const rows = this.refreshTokens.filter((t) => matches(t, where));
      rows.forEach((t) => Object.assign(t, data));
      return { count: rows.length };
    },
  };

  riskSettingsRows: Row[] = [];

  riskSettings = {
    findUnique: async ({ where, select }: Row) => {
      const row = this.riskSettingsRows.find((r) => r.userId === where.userId);
      return row ? pick(row, select) : null;
    },
    update: async ({ where, data, select }: Row) => {
      const row = this.riskSettingsRows.find((r) => r.userId === where.userId)!;
      for (const [key, value] of Object.entries(data)) {
        row[key] = new Prisma.Decimal(value as number);
      }
      return pick(row, select);
    },
  };

  notificationSettingsRows: Row[] = [];

  notificationSettings = {
    findUnique: async ({ where, select }: Row) => {
      const row = this.notificationSettingsRows.find(
        (r) => r.userId === where.userId,
      );
      return row ? pick(row, select) : null;
    },
    update: async ({ where, data, select }: Row) => {
      const row = this.notificationSettingsRows.find(
        (r) => r.userId === where.userId,
      )!;
      Object.assign(row, data);
      return pick(row, select);
    },
  };

  notifications: Row[] = [];

  notification = {
    create: async ({ data, select }: Row) => {
      if (
        data.dedupeKey &&
        this.notifications.some(
          (n) => n.userId === data.userId && n.dedupeKey === data.dedupeKey,
        )
      ) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: 'test' },
        );
      }
      const row = {
        id: randomUUID(),
        critical: false,
        deliveries: [],
        dedupeKey: null,
        readAt: null,
        createdAt: this.tick(),
        ...Object.fromEntries(
          Object.entries(data).filter(([, v]) => v !== undefined),
        ),
      };
      this.notifications.push(row);
      return pick({ ...row }, select);
    },
    findFirst: async ({ where, select }: Row) => {
      const row = this.notifications.find((n) => matches(n, where));
      return row ? pick({ ...row }, select) : null;
    },
    findMany: async ({ where, orderBy, take, select }: Row) => {
      const rows = this.notifications
        .filter((n) => matches(n, where))
        .sort((a, b) =>
          orderBy?.createdAt === 'desc'
            ? b.createdAt - a.createdAt
            : a.createdAt - b.createdAt,
        )
        .slice(0, take);
      return rows.map((r) => pick({ ...r }, select));
    },
    count: async ({ where }: Row) =>
      this.notifications.filter((n) => matches(n, where)).length,
    update: async ({ where, data, select }: Row) => {
      const row = this.notifications.find((n) => n.id === where.id)!;
      Object.assign(row, data);
      return pick({ ...row }, select);
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = this.notifications.filter((n) => matches(n, where));
      rows.forEach((n) => Object.assign(n, data));
      return { count: rows.length };
    },
  };

  digestReports: Row[] = [];

  digestReport = {
    create: async ({ data, select }: Row) => {
      if (
        this.digestReports.some(
          (d) =>
            d.userId === data.userId &&
            d.period === data.period &&
            d.periodStart.getTime() === data.periodStart.getTime(),
        )
      ) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: 'test' },
        );
      }
      const row = {
        id: randomUUID(),
        readAt: null,
        generatedAt: this.tick(),
        ...data,
        portfolioDeltaPct:
          data.portfolioDeltaPct == null
            ? null
            : new Prisma.Decimal(data.portfolioDeltaPct),
      };
      this.digestReports.push(row);
      return pick({ ...row }, select);
    },
    findFirst: async ({ where, select }: Row) => {
      const row = this.digestReports.find((d) => matches(d, where));
      return row ? pick({ ...row }, select) : null;
    },
    findMany: async ({ where, take, select }: Row) =>
      this.digestReports
        .filter((d) => matches(d, where))
        .sort((a, b) => b.generatedAt - a.generatedAt)
        .slice(0, take)
        .map((d) => pick({ ...d }, select)),
    count: async ({ where }: Row) =>
      this.digestReports.filter((d) => matches(d, where)).length,
    updateMany: async ({ where, data }: Row) => {
      const rows = this.digestReports.filter((d) => matches(d, where));
      rows.forEach((d) => Object.assign(d, data));
      return { count: rows.length };
    },
  };

  alertConfigs: Row[] = [];

  alertConfig = {
    count: async ({ where }: Row) =>
      this.alertConfigs.filter((a) => matches(a, where)).length,
    create: async ({ data, select }: Row) => {
      const row = {
        id: randomUUID(),
        isTriggered: false,
        lastTriggeredAt: null,
        createdAt: this.tick(),
        ...data,
      };
      this.alertConfigs.push(row);
      return pick({ ...row }, select);
    },
    findMany: async ({ where, select }: Row) => {
      // Filtre relationnel `user: { ... }` : porte sur le propriétaire de l'alerte.
      const { user, ...own } = where;
      return this.alertConfigs
        .filter((a) => matches(a, own))
        .filter(
          (a) =>
            !user ||
            matches(this.users.find((u) => u.id === a.userId) ?? {}, user),
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((a) => pick({ ...a }, select));
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = this.alertConfigs.filter((a) => matches(a, where));
      rows.forEach((a) => Object.assign(a, data));
      return { count: rows.length };
    },
    findFirst: async ({ where, select }: Row) => {
      const row = this.alertConfigs.find((a) => matches(a, where));
      return row ? pick({ ...row }, select) : null;
    },
    update: async ({ where, data, select }: Row) => {
      const row = this.alertConfigs.find((a) => a.id === where.id)!;
      Object.assign(row, data);
      return pick({ ...row }, select);
    },
    delete: async ({ where }: Row) => {
      this.alertConfigs = this.alertConfigs.filter((a) => a.id !== where.id);
    },
  };

  equitySnapshots: Row[] = [];

  equitySnapshot = {
    findUnique: async ({ where }: Row) => {
      const row = this.equitySnapshots.find(
        (s) =>
          s.userId === where.userId_localDate.userId &&
          s.localDate === where.userId_localDate.localDate,
      );
      return row ? { ...row } : null;
    },
    create: async ({ data }: Row) => {
      if (
        this.equitySnapshots.some(
          (s) => s.userId === data.userId && s.localDate === data.localDate,
        )
      ) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: 'test' },
        );
      }
      const row = { id: randomUUID(), capturedAt: new Date(), ...data };
      this.equitySnapshots.push(row);
      return row;
    },
  };

  assets: Row[] = [];
  private clock = Date.now();
  /** Horloge strictement croissante : deux écritures successives ont toujours un `updatedAt` différent. */
  private tick = () => new Date(++this.clock);

  asset = {
    // Comme Prisma, renvoie des copies : une mise à jour ultérieure ne modifie pas ce que l'appelant a lu.
    findUnique: async ({ where }: Row) => {
      const row = this.assets.find(
        (a) =>
          a.userId === where.userId_symbol.userId &&
          a.symbol === where.userId_symbol.symbol,
      );
      return row ? { ...row } : null;
    },
    findMany: async ({ where }: Row) =>
      this.assets
        .filter((a) => matches(a, where))
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((a) => ({ ...a })),
    create: async ({ data }: Row) => {
      if (
        this.assets.some(
          (a) => a.userId === data.userId && a.symbol === data.symbol,
        )
      ) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: 'test' },
        );
      }
      const row = { id: randomUUID(), updatedAt: this.tick(), ...data };
      this.assets.push(row);
      return row;
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = this.assets.filter((a) => matches(a, where));
      rows.forEach((a) => Object.assign(a, data, { updatedAt: this.tick() }));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Row) => {
      const rows = this.assets.filter((a) => matches(a, where));
      this.assets = this.assets.filter((a) => !rows.includes(a));
      return { count: rows.length };
    },
  };

  exchangeConfigs: Row[] = [];
  tradeLogs: Row[] = [];

  exchangeConfig = {
    create: async ({ data, select }: Row) => {
      const duplicate = this.exchangeConfigs.some(
        (c) =>
          c.userId === data.userId &&
          c.exchange === data.exchange &&
          c.label === data.label,
      );
      if (duplicate) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: 'test' },
        );
      }
      const row = { statusReason: null, createdAt: new Date(), ...data };
      this.exchangeConfigs.push(row);
      return pick(row, select);
    },
    findMany: async ({ where, select }: Row) =>
      this.exchangeConfigs
        .filter((c) => matches(c, where))
        .map((c) => pick(c, select)),
    findFirst: async ({ where }: Row) =>
      this.exchangeConfigs.find((c) => matches(c, where)) ?? null,
    update: async ({ where, data, select }: Row) => {
      const row = this.exchangeConfigs.find((c) => c.id === where.id)!;
      Object.assign(row, data);
      return pick(row, select);
    },
    delete: async ({ where }: Row) => {
      this.exchangeConfigs = this.exchangeConfigs.filter(
        (c) => c.id !== where.id,
      );
    },
  };

  tradeLog = {
    count: async ({ where }: Row) =>
      this.tradeLogs.filter((t) => matches(t, where)).length,
  };

  auditLog = {
    create: async ({ data }: Row) => {
      this.auditLogs.push({ id: randomUUID(), ...data });
    },
  };
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) =>
    // Seul l'opérateur `{ not: null }` est géré, avec l'égalité simple.
    value instanceof Date
      ? row[key] instanceof Date && row[key].getTime() === value.getTime()
      : value !== null && typeof value === 'object' && 'not' in value
        ? row[key] !== value.not
        : value !== null && typeof value === 'object' && 'lt' in value
          ? row[key] < value.lt
          : value !== null && typeof value === 'object' && 'gte' in value
            ? row[key] >= value.gte
            : value !== null && typeof value === 'object' && 'in' in value
              ? value.in.includes(row[key])
              : row[key] === value,
  );
}

function pick(row: Row, select?: Row): Row {
  if (!select) return row;
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k]]),
  );
}
