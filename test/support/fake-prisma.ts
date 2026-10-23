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
        deletedAt: null,
        ...Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined),
        ),
      };
      this.users.push(row);
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

  auditLog = {
    create: async ({ data }: Row) => {
      this.auditLogs.push({ id: randomUUID(), ...data });
    },
  };
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function pick(row: Row, select?: Row): Row {
  if (!select) return row;
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k]]),
  );
}
