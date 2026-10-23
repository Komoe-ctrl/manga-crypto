import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  /** Format « domaine.verbe » (ex. auth.login, exchange.key_added). */
  action: string;
  userId?: string | null;
  entityType?: string;
  entityId?: string;
  /** Identifiants et valeurs non sensibles uniquement : jamais de mot de passe, token ni clé API. */
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
}

/** Écriture dans le journal d'audit (table immuable). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action: entry.action,
        userId: entry.userId ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent?.slice(0, 255),
      },
    });
  }
}
