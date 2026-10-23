import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { EncryptionService } from '../crypto/encryption.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { type Exchange, ExchangeStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateExchangeConfigDto,
  ExchangeConfigDto,
} from './dto/exchange.dto.js';
import {
  ExchangeUnavailableError,
  InvalidCredentialsError,
  type ExchangeCredentials,
  type PermissionCheck,
} from './verification/exchange-verifier.js';
import { VerifierRegistry } from './verification/verifier.registry.js';

/** Champs exposés : jamais de colonne chiffrée. */
const PUBLIC_SELECT = {
  id: true,
  exchange: true,
  label: true,
  sandbox: true,
  status: true,
  statusReason: true,
  permissions: true,
  apiKeyHint: true,
  verifiedAt: true,
  createdAt: true,
} as const;

const SANDBOX_NOTE = 'Testnet : permissions non vérifiables (fonds fictifs)';
const WITHDRAWAL_REASON =
  'Droit « Withdrawal » détecté : seuls Read et Trade sont acceptés';
const INVALID_KEY_REASON = 'Clé invalide ou révoquée';

/**
 * Gestion des clés API d'échange. C'est, avec le futur module d'ordres, le seul code qui voit une clé en clair.
 *
 * Écriture : vérification des permissions (clé en mémoire) → chiffrement → stockage. Une clé qui peut retirer
 * des fonds est refusée et n'est jamais stockée.
 */
@Injectable()
export class ExchangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly verifiers: VerifierRegistry,
  ) {}

  async create(
    userId: string,
    dto: CreateExchangeConfigDto,
    ctx: RequestContext,
  ): Promise<ExchangeConfigDto> {
    const sandbox = dto.sandbox ?? false;
    const credentials = { apiKey: dto.apiKey, apiSecret: dto.apiSecret };
    const auditBase = { userId, entityType: 'ExchangeConfig', ...ctx };
    const metadata = { exchange: dto.exchange, label: dto.label, sandbox };

    const check = await this.check(dto.exchange, credentials, sandbox).catch(
      async (error: unknown) => {
        if (error instanceof InvalidCredentialsError) {
          await this.audit.log({
            ...auditBase,
            action: 'exchange.key_rejected',
            metadata: { ...metadata, reason: 'invalid_key' },
          });
          throw new UnprocessableEntityException(INVALID_KEY_REASON);
        }
        throw error;
      },
    );
    if (check.withdrawalEnabled) {
      await this.audit.log({
        ...auditBase,
        action: 'exchange.key_rejected',
        metadata: { ...metadata, reason: 'withdrawal' },
      });
      throw new UnprocessableEntityException(WITHDRAWAL_REASON);
    }

    // L'id est généré ici pour servir de contexte (AAD) : un chiffré recopié sur une autre ligne ne se déchiffre plus.
    const id = randomUUID();
    const apiKey = this.encryption.encrypt(dto.apiKey, aad(id, 'apiKey'));
    const apiSecret = this.encryption.encrypt(
      dto.apiSecret,
      aad(id, 'apiSecret'),
    );

    try {
      const created = await this.prisma.exchangeConfig.create({
        data: {
          id,
          userId,
          exchange: dto.exchange,
          label: dto.label,
          sandbox,
          apiKeyCipher: apiKey.ciphertext,
          apiKeyIv: apiKey.iv,
          apiKeyTag: apiKey.authTag,
          apiSecretCipher: apiSecret.ciphertext,
          apiSecretIv: apiSecret.iv,
          apiSecretTag: apiSecret.authTag,
          keyVersion: apiKey.keyVersion,
          apiKeyHint: dto.apiKey.slice(-4),
          status: ExchangeStatus.ACTIVE,
          statusReason: check.verified ? null : SANDBOX_NOTE,
          permissions: check.permissions,
          verifiedAt: check.verified ? new Date() : null,
        },
        select: PUBLIC_SELECT,
      });
      await this.audit.log({
        ...auditBase,
        action: 'exchange.key_added',
        entityId: id,
        metadata: {
          ...metadata,
          permissions: check.permissions,
          keyVersion: apiKey.keyVersion,
        },
      });
      return created;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Une configuration existe déjà pour cette plateforme et ce libellé',
        );
      }
      throw error;
    }
  }

  list(userId: string): Promise<ExchangeConfigDto[]> {
    return this.prisma.exchangeConfig.findMany({
      where: { userId },
      select: PUBLIC_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Re-vérifie une clé déjà stockée (droits modifiés côté plateforme, clé révoquée). Rend ACTIVE ou REJECTED ;
   * c'est aussi la seule façon de réactiver une configuration désactivée.
   */
  async verify(
    userId: string,
    id: string,
    ctx: RequestContext,
  ): Promise<ExchangeConfigDto> {
    const row = await this.findOwned(userId, id);
    const credentials = this.decrypt(row);

    let status: ExchangeStatus;
    let statusReason: string | null;
    let check: PermissionCheck | undefined;
    try {
      check = await this.check(row.exchange, credentials, row.sandbox);
      if (check.withdrawalEnabled) {
        status = ExchangeStatus.REJECTED;
        statusReason = WITHDRAWAL_REASON;
      } else {
        status = ExchangeStatus.ACTIVE;
        statusReason = check.verified ? null : SANDBOX_NOTE;
      }
    } catch (error) {
      if (!(error instanceof InvalidCredentialsError)) throw error;
      status = ExchangeStatus.REJECTED;
      statusReason = INVALID_KEY_REASON;
    }

    const updated = await this.prisma.exchangeConfig.update({
      where: { id },
      data: {
        status,
        statusReason,
        ...(check && {
          permissions: check.permissions,
          verifiedAt: check.verified ? new Date() : null,
        }),
      },
      select: PUBLIC_SELECT,
    });
    await this.audit.log({
      userId,
      action:
        status === ExchangeStatus.ACTIVE
          ? 'exchange.verified'
          : 'exchange.rejected',
      entityType: 'ExchangeConfig',
      entityId: id,
      metadata: {
        exchange: row.exchange,
        status,
        permissions: updated.permissions,
      },
      ...ctx,
    });
    return updated;
  }

  async disable(
    userId: string,
    id: string,
    ctx: RequestContext,
  ): Promise<ExchangeConfigDto> {
    await this.findOwned(userId, id);
    const updated = await this.prisma.exchangeConfig.update({
      where: { id },
      data: { status: ExchangeStatus.DISABLED, statusReason: null },
      select: PUBLIC_SELECT,
    });
    await this.audit.log({
      userId,
      action: 'exchange.disabled',
      entityType: 'ExchangeConfig',
      entityId: id,
      ...ctx,
    });
    return updated;
  }

  /** Suppression définitive des clés chiffrées. Impossible si des ordres existent : le journal des ordres est conservé. */
  async remove(userId: string, id: string, ctx: RequestContext): Promise<void> {
    await this.findOwned(userId, id);
    if (
      (await this.prisma.tradeLog.count({ where: { exchangeConfigId: id } })) >
      0
    ) {
      throw new ConflictException(
        'Des ordres sont liés à cette configuration : désactivez-la plutôt que de la supprimer',
      );
    }
    await this.prisma.exchangeConfig.delete({ where: { id } });
    await this.audit.log({
      userId,
      action: 'exchange.deleted',
      entityType: 'ExchangeConfig',
      entityId: id,
      ...ctx,
    });
  }

  /**
   * Clés de la configuration éligible au trading réel : active, vérifiée et hors testnet ; `null` s'il n'y en a pas.
   * Appelée **à chaque ordre LIVE** (l'éligibilité n'est pas figée au passage en LIVE, voir D28). Réservée au module
   * d'ordres ; le résultat ne doit jamais être journalisé, stocké ni renvoyé par l'API.
   */
  async getLiveCredentials(userId: string): Promise<{
    configId: string;
    exchange: Exchange;
    apiKey: string;
    apiSecret: string;
  } | null> {
    const row = await this.prisma.exchangeConfig.findFirst({
      where: {
        userId,
        status: ExchangeStatus.ACTIVE,
        sandbox: false,
        verifiedAt: { not: null },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!row) return null;
    return { configId: row.id, exchange: row.exchange, ...this.decrypt(row) };
  }

  /** Appelle le vérificateur et traduit une indisponibilité en 503 (sans conclure sur la clé). */
  private async check(
    exchange: CreateExchangeConfigDto['exchange'],
    credentials: ExchangeCredentials,
    sandbox: boolean,
  ): Promise<PermissionCheck> {
    const verifier = this.verifiers.get(exchange);
    try {
      return await verifier.verify(credentials, sandbox);
    } catch (error) {
      if (error instanceof ExchangeUnavailableError) {
        throw new ServiceUnavailableException(
          'Vérification impossible pour le moment, réessayez',
        );
      }
      throw error;
    }
  }

  private async findOwned(userId: string, id: string) {
    const row = await this.prisma.exchangeConfig.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  private decrypt(
    row: NonNullable<Awaited<ReturnType<ExchangesService['findOwned']>>>,
  ): ExchangeCredentials {
    return {
      apiKey: this.encryption.decrypt(
        {
          ciphertext: row.apiKeyCipher,
          iv: row.apiKeyIv,
          authTag: row.apiKeyTag,
          keyVersion: row.keyVersion,
        },
        aad(row.id, 'apiKey'),
      ),
      apiSecret: this.encryption.decrypt(
        {
          ciphertext: row.apiSecretCipher,
          iv: row.apiSecretIv,
          authTag: row.apiSecretTag,
          keyVersion: row.keyVersion,
        },
        aad(row.id, 'apiSecret'),
      ),
    };
  }
}

/** Contexte authentifié du chiffrement : lie le chiffré à sa ligne et à son champ. */
function aad(id: string, field: 'apiKey' | 'apiSecret'): string {
  return `exchange-config:${id}:${field}`;
}
