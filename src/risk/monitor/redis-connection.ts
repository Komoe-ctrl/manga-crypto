import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis, type RedisOptions } from 'ioredis';

/** Convertit une URL `redis://[user:motdepasse@]hôte:port[/base]` (ou `rediss://`) en options ioredis. */
export function redisOptions(url: string): RedisOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db:
      parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    // Exigé par BullMQ pour les connexions bloquantes des workers.
    maxRetriesPerRequest: null,
  };
}

/**
 * Client Redis partagé par BullMQ. En ESM natif, BullMQ ne peut pas charger `ioredis` lui-même à partir d'options :
 * il faut lui passer un client déjà construit. Ce client n'appartient pas à BullMQ, donc il est fermé ici.
 */
@Injectable()
export class RedisConnection implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(
      redisOptions(config.getOrThrow<string>('REDIS_URL')),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

@Module({ providers: [RedisConnection], exports: [RedisConnection] })
export class RedisConnectionModule {}
