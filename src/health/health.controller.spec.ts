import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RedisConnection } from '../queue/redis-connection.js';
import { CHECK_TIMEOUT_MS, HealthController } from './health.controller.js';

const prisma = (query: () => Promise<unknown>) =>
  ({ $queryRaw: query }) as unknown as PrismaService;
const redis = (ping: () => Promise<unknown>) =>
  ({ client: { ping } }) as unknown as RedisConnection;

describe('HealthController', () => {
  it('répond ok quand la base et Redis répondent', async () => {
    const controller = new HealthController(
      prisma(() => Promise.resolve([{ '?column?': 1 }])),
      redis(() => Promise.resolve('PONG')),
    );
    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it("marque Redis « disabled » quand l'instance n'en utilise pas (jobs de fond coupés)", async () => {
    const controller = new HealthController(prisma(() => Promise.resolve([])));
    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', redis: 'disabled' },
    });
  });

  it('répond 503 quand la base ne répond pas, sans détail technique', async () => {
    const controller = new HealthController(
      prisma(() =>
        Promise.reject(new Error('connect ECONNREFUSED db.interne:5432')),
      ),
      redis(() => Promise.resolve('PONG')),
    );
    const error = await controller.check().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const body = (error as ServiceUnavailableException).getResponse();
    expect(body).toEqual({
      status: 'degraded',
      checks: { database: 'down', redis: 'up' },
    });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('répond 503 quand Redis ne répond pas', async () => {
    const controller = new HealthController(
      prisma(() => Promise.resolve([])),
      redis(() => Promise.reject(new Error('Connection is closed'))),
    );
    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('un contrôle trop lent compte comme un échec', async () => {
    vi.useFakeTimers();
    try {
      const controller = new HealthController(
        prisma(() => new Promise(() => undefined)), // ne répond jamais
        redis(() => Promise.resolve('PONG')),
      );
      const pending = controller.check().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 1);
      const error = await pending;
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({
        checks: { database: 'down' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
