import type { Queue } from 'bullmq';
import { FakePrisma } from '../../../test/support/fake-prisma.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type {
  DailyLossMonitor,
  DailyLossOutcome,
} from './daily-loss.monitor.js';
import { redisOptions } from './redis-connection.js';
import {
  CHECK_INTERVAL_MS,
  RiskMonitorProcessor,
  RiskMonitorScheduler,
} from './risk-monitor.processor.js';

async function build(outcomes: Record<string, DailyLossOutcome | Error>) {
  const prisma = new FakePrisma();
  for (const id of Object.keys(outcomes)) {
    await prisma.user.create({
      data: { id, email: `${id}@example.com`, passwordHash: 'x' },
      select: { id: true },
    });
  }
  // L'identifiant est gÃ©nÃ©rÃ© par la base : on le remplace par celui du scÃ©nario.
  prisma.users.forEach((u, i) => (u.id = Object.keys(outcomes)[i]));

  const monitor = {
    checkUser: vi.fn(async (id: string) => {
      const outcome = outcomes[id];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
  return {
    monitor,
    processor: new RiskMonitorProcessor(
      prisma as unknown as PrismaService,
      monitor as unknown as DailyLossMonitor,
    ),
  };
}

describe('RiskMonitorProcessor', () => {
  it('vÃ©rifie chaque utilisateur actif et compte les pauses', async () => {
    const { processor, monitor } = await build({
      a: 'ok',
      b: 'paused',
      c: 'no_prices',
    });
    await expect(processor.process()).resolves.toEqual({
      checked: 3,
      paused: 1,
      failed: 0,
    });
    expect(monitor.checkUser).toHaveBeenCalledTimes(3);
  });

  it("isole l'Ã©chec d'un utilisateur : les autres sont quand mÃªme surveillÃ©s", async () => {
    const { processor, monitor } = await build({
      a: 'paused',
      b: new Error('base indisponible'),
      c: 'ok',
    });
    await expect(processor.process()).resolves.toEqual({
      checked: 2,
      paused: 1,
      failed: 1,
    });
    expect(monitor.checkUser).toHaveBeenCalledTimes(3);
  });
});

describe('RiskMonitorScheduler', () => {
  it('programme un job rÃ©pÃ©table toutes les 5 minutes, de faÃ§on idempotente (mÃªme identifiant)', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
    await new RiskMonitorScheduler(queue as unknown as Queue).onModuleInit();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'daily-loss-check',
      { every: CHECK_INTERVAL_MS },
      { name: 'check' },
    );
    expect(CHECK_INTERVAL_MS).toBe(300_000);
  });
});

describe('redisOptions', () => {
  it('lit hÃ´te, port et base', () => {
    expect(redisOptions('redis://localhost:6379')).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: undefined,
    });
    expect(redisOptions('redis://cache.internal:6380/2')).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      db: 2,
    });
  });

  it('utilise le port par dÃ©faut', () => {
    expect(redisOptions('redis://localhost')).toMatchObject({ port: 6379 });
  });

  it('dÃ©code les identifiants et active TLS pour rediss://', () => {
    expect(redisOptions('rediss://user:p%40ss@host:6379')).toMatchObject({
      username: 'user',
      password: 'p@ss',
      tls: {},
    });
  });
});
