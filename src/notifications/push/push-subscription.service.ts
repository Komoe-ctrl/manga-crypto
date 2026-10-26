import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestContext } from '../../auth/auth.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { pushConfig } from './push-config.js';
import {
  MAX_PUSH_SUBSCRIPTIONS,
  type PushSubscriptionRecord,
  hasValidKeys,
  isAllowedPushEndpoint,
  parseSubscriptions,
} from './push-subscription.js';

export interface PushStatus {
  /** Le serveur a des clés VAPID : le Push peut fonctionner. */
  configured: boolean;
  /** Clé publique VAPID à donner à `PushManager.subscribe` (non secrète). */
  publicKey: string | null;
  /** Nombre d'appareils abonnés de l'utilisateur. */
  subscriptions: number;
}

/**
 * Appareils abonnés au Web Push. Ni l'adresse d'un abonnement ni ses clés ne sont jamais journalisées, auditées
 * ou renvoyées : seul le nombre d'appareils sort de ce service.
 */
@Injectable()
export class PushSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async status(userId: string): Promise<PushStatus> {
    const vapid = pushConfig(this.config);
    return {
      configured: vapid !== null,
      publicKey: vapid?.publicKey ?? null,
      subscriptions: (await this.read(userId)).length,
    };
  }

  /** Ajoute ou remplace (même adresse) un appareil. Au-delà de 5, le plus ancien est écarté. */
  async add(
    userId: string,
    input: { endpoint: string; p256dh: string; auth: string },
    ctx: RequestContext,
  ): Promise<PushStatus> {
    if (!isAllowedPushEndpoint(input.endpoint)) {
      throw new UnprocessableEntityException(
        "Adresse d'abonnement refusée : seul le service Push d'un navigateur connu est accepté (https)",
      );
    }
    if (!hasValidKeys(input.p256dh, input.auth)) {
      throw new UnprocessableEntityException(
        "Clés d'abonnement invalides (p256dh : point P-256 de 65 octets, auth : 16 octets, en base64url)",
      );
    }

    const others = (await this.read(userId)).filter(
      (s) => s.endpoint !== input.endpoint,
    );
    const next: PushSubscriptionRecord[] = [
      ...others,
      { ...input, createdAt: new Date().toISOString() },
    ].slice(-MAX_PUSH_SUBSCRIPTIONS);
    await this.write(userId, next);

    await this.audit.log({
      userId,
      action: 'push_subscription.added',
      entityType: 'NotificationSettings',
      metadata: { devices: next.length },
      ...ctx,
    });
    return this.status(userId);
  }

  /** Retire un appareil. Idempotent : retirer un appareil inconnu ne change rien. */
  async remove(
    userId: string,
    endpoint: string,
    ctx: RequestContext,
  ): Promise<PushStatus> {
    const current = await this.read(userId);
    const next = current.filter((s) => s.endpoint !== endpoint);
    if (next.length !== current.length) {
      await this.write(userId, next);
      await this.audit.log({
        userId,
        action: 'push_subscription.removed',
        entityType: 'NotificationSettings',
        metadata: { devices: next.length },
        ...ctx,
      });
    }
    return this.status(userId);
  }

  /** Retire un abonnement que le service Push a déclaré expiré (404 ou 410) : le navigateur l'a révoqué. */
  async removeExpired(userId: string, endpoint: string): Promise<void> {
    const current = await this.read(userId);
    const next = current.filter((s) => s.endpoint !== endpoint);
    if (next.length === current.length) return;
    await this.write(userId, next);
    await this.audit.log({
      userId,
      action: 'push_subscription.expired',
      entityType: 'NotificationSettings',
      metadata: { devices: next.length },
    });
  }

  private async read(userId: string): Promise<PushSubscriptionRecord[]> {
    const row = await this.prisma.notificationSettings.findUnique({
      where: { userId },
      select: { pushSubscription: true },
    });
    if (!row) throw new NotFoundException();
    return parseSubscriptions(row.pushSubscription);
  }

  private async write(
    userId: string,
    subscriptions: PushSubscriptionRecord[],
  ): Promise<void> {
    await this.prisma.notificationSettings.update({
      where: { userId },
      data: {
        pushSubscription:
          subscriptions.length > 0
            ? (subscriptions as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
      },
    });
  }
}
