import {
  Controller,
  Get,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisConnection } from '../queue/redis-connection.js';

/** Un contrôle trop lent compte comme un échec : une sonde de plateforme ne doit pas rester suspendue. */
export const CHECK_TIMEOUT_MS = 2_000;

type CheckState = 'up' | 'down' | 'disabled';

export class HealthDto {
  @ApiProperty({ enum: ['ok', 'degraded'] })
  status!: 'ok' | 'degraded';

  @ApiProperty({
    description:
      'up : répond ; down : ne répond pas ; disabled : non utilisé par cette instance (Redis sans jobs de fond)',
    example: { database: 'up', redis: 'up' },
  })
  checks!: Record<'database' | 'redis', CheckState>;
}

async function within(
  check: () => Promise<unknown>,
  ms: number,
): Promise<CheckState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
    return 'up';
  } catch {
    // Aucun détail renvoyé : l'erreur (adresse de la base, identifiants) n'a rien à faire dans une réponse publique.
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sonde de santé pour la plateforme d'hébergement (redémarrage automatique, déploiement sans coupure) :
 * 200 si la base répond (et Redis, quand les jobs de fond l'utilisent), 503 sinon. Publique et hors limitation de
 * débit : elle ne renvoie ni donnée ni détail technique.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisConnection,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  @ApiOkResponse({ type: HealthDto })
  @ApiServiceUnavailableResponse({ type: HealthDto })
  async check(): Promise<HealthDto> {
    const [database, redis] = await Promise.all([
      within(() => this.prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS),
      this.redis
        ? within(() => this.redis!.client.ping(), CHECK_TIMEOUT_MS)
        : Promise.resolve<CheckState>('disabled'),
    ]);
    const body: HealthDto = {
      status: database === 'down' || redis === 'down' ? 'degraded' : 'ok',
      checks: { database, redis },
    };
    if (body.status === 'degraded') throw new ServiceUnavailableException(body);
    return body;
  }
}
