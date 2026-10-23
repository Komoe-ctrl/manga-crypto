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
    value !== null && typeof value === 'object' && 'not' in value
      ? row[key] !== value.not
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
