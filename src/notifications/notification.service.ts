import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  NotificationChannel,
  NotificationStatus,
} from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeBus } from '../realtime/realtime-events.js';
import {
  CHANNEL_SENDERS,
  type ChannelSender,
  type DeliveryResult,
} from './channels/channel-sender.js';
import { isInNightWindow } from './night-mode.js';

export interface NotifyInput {
  title: string;
  body: string;
  /** Critique : passe même en Mode Nuit (stop-loss exécuté, perte journalière max, anomalie de compte). */
  critical?: boolean;
  /** Envoi immédiat, sans tenir compte du Mode Nuit (message de test) ; n'implique pas « critique ». */
  immediate?: boolean;
  /** Évite les doublons d'un même événement : un second appel avec la même clé renvoie la notification existante. */
  dedupeKey?: string;
  /**
   * Canal imposé (alerte configurée sur un canal précis, maquette) : la notification n'est envoyée que sur celui-là,
   * sans tenir compte des canaux activés globalement dans les réglages. Absent : tous les canaux activés.
   */
  channel?: NotificationChannel;
}

export interface NotificationView {
  id: string;
  title: string;
  body: string;
  critical: boolean;
  status: NotificationStatus;
  deliveries: DeliveryResult[];
  readAt: Date | null;
  /** Rapport du matin qui a repris cette notification (statut DIGESTED), sinon null. */
  digestId: string | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  title: true,
  body: true,
  critical: true,
  status: true,
  deliveries: true,
  readAt: true,
  digestId: true,
  createdAt: true,
} as const;

/** Réglages de repli si la ligne de réglages manque (le compte en crée une à l'inscription). */
interface DispatchSettings {
  nightModeEnabled: boolean;
  nightStartMinute: number;
  nightEndMinute: number;
  pushEnabled: boolean;
  telegramEnabled: boolean;
  emailEnabled: boolean;
  telegramChatId: string | null;
  notificationEmail: string | null;
}

const DEFAULT_SETTINGS: DispatchSettings = {
  nightModeEnabled: true,
  nightStartMinute: 1320,
  nightEndMinute: 420,
  pushEnabled: true,
  telegramEnabled: false,
  emailEnabled: false,
  telegramChatId: null,
  notificationEmail: null,
};

/**
 * Centre de notifications (SPEC module 3). Chaque événement est enregistré (boîte de réception) puis, sauf Mode Nuit,
 * envoyé sur les canaux activés. Pendant la plage du Mode Nuit, une notification non critique est mise en attente
 * (`HELD`) pour le rapport du matin ; une notification critique passe toujours.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CHANNEL_SENDERS) private readonly senders: ChannelSender[],
    @Optional() private readonly realtime?: RealtimeBus,
  ) {}

  /** Renvoie `null` si l'utilisateur est introuvable ou désactivé. */
  async notify(
    userId: string,
    input: NotifyInput,
    now: Date = new Date(),
  ): Promise<NotificationView | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, timezone: true },
    });
    if (!user) return null;

    if (input.dedupeKey) {
      const existing = await this.findByDedupeKey(userId, input.dedupeKey);
      if (existing) return existing;
    }

    const settings =
      (await this.prisma.notificationSettings.findUnique({
        where: { userId },
      })) ?? DEFAULT_SETTINGS;

    const held =
      !input.critical &&
      !input.immediate &&
      settings.nightModeEnabled &&
      isInNightWindow(
        now,
        user.timezone,
        settings.nightStartMinute,
        settings.nightEndMinute,
      );

    let created: NotificationView;
    try {
      created = toView(
        await this.prisma.notification.create({
          data: {
            userId,
            title: input.title.slice(0, 200),
            body: input.body,
            critical: input.critical ?? false,
            status: held
              ? NotificationStatus.HELD
              : NotificationStatus.DISPATCHED,
            dedupeKey: input.dedupeKey,
          },
          select: SELECT,
        }),
      );
    } catch (error) {
      // Deux appels simultanés avec la même clé : la contrainte unique départage, le perdant renvoie l'existant.
      if (
        input.dedupeKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByDedupeKey(userId, input.dedupeKey);
        if (existing) return existing;
      }
      throw error;
    }
    // Poussée au front dès l'enregistrement (boîte de réception), y compris en Mode Nuit : le front ouvert l'affiche,
    // seul l'envoi sur les canaux externes est retenu.
    this.realtime?.publish(userId, {
      type: 'notification',
      data: {
        id: created.id,
        title: created.title,
        body: created.body,
        critical: created.critical,
        status: created.status,
        createdAt: created.createdAt,
      },
    });
    if (held) return created;

    const deliveries = await this.dispatch(
      created,
      settings,
      user.email,
      input.channel,
    );
    if (created.critical && !deliveries.some((d) => d.status === 'SENT')) {
      this.logger.warn(
        `Notification critique sans livraison sur aucun canal (userId=${userId})`,
      );
    }
    return toView(
      await this.prisma.notification.update({
        where: { id: created.id },
        data: { deliveries: deliveries as unknown as Prisma.InputJsonValue },
        select: SELECT,
      }),
    );
  }

  async list(
    userId: string,
    options: { limit: number; before?: Date; unreadOnly?: boolean },
  ): Promise<{ items: NotificationView[]; unreadCount: number }> {
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          userId,
          ...(options.unreadOnly && { readAt: null }),
          ...(options.before && { createdAt: { lt: options.before } }),
        },
        orderBy: { createdAt: 'desc' },
        take: options.limit,
        select: SELECT,
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items: rows.map(toView), unreadCount };
  }

  /** Marque une notification comme lue (idempotent). 404 si elle n'appartient pas à l'utilisateur. */
  async markRead(userId: string, id: string): Promise<NotificationView> {
    const row = await this.prisma.notification.findFirst({
      where: { id, userId },
      select: SELECT,
    });
    if (!row) throw new NotFoundException();
    if (row.readAt) return toView(row);
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return toView(
      (await this.prisma.notification.findFirst({
        where: { id, userId },
        select: SELECT,
      }))!,
    );
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  private async findByDedupeKey(
    userId: string,
    dedupeKey: string,
  ): Promise<NotificationView | null> {
    const row = await this.prisma.notification.findFirst({
      where: { userId, dedupeKey },
      select: SELECT,
    });
    return row && toView(row);
  }

  private async dispatch(
    notification: NotificationView,
    settings: DispatchSettings,
    userEmail: string,
    forcedChannel?: NotificationChannel,
  ): Promise<DeliveryResult[]> {
    const enabled: NotificationChannel[] = forcedChannel
      ? [forcedChannel]
      : [
          ...(settings.pushEnabled ? [NotificationChannel.PUSH] : []),
          ...(settings.telegramEnabled ? [NotificationChannel.TELEGRAM] : []),
          ...(settings.emailEnabled ? [NotificationChannel.EMAIL] : []),
        ];
    const recipient = {
      telegramChatId: settings.telegramChatId,
      email: settings.notificationEmail ?? userEmail,
    };

    return Promise.all(
      enabled.map(async (channel): Promise<DeliveryResult> => {
        const sender = this.senders.find((s) => s.channel === channel);
        if (!sender)
          return {
            channel,
            status: 'FAILED',
            reason: 'channel_not_implemented',
          };
        try {
          return await sender.send(
            {
              title: notification.title,
              body: notification.body,
              critical: notification.critical,
            },
            recipient,
          );
        } catch (error) {
          // Un envoyeur ne doit pas lever ; si c'est le cas, on n'enregistre que le nom de l'erreur.
          this.logger.error(
            `Envoi en erreur (canal ${channel}) : ${error instanceof Error ? error.name : 'erreur inconnue'}`,
          );
          return { channel, status: 'FAILED', reason: 'sender_error' };
        }
      }),
    );
  }
}

type Row = Omit<NotificationView, 'deliveries'> & { deliveries: unknown };

const toView = (row: Row): NotificationView => ({
  ...row,
  deliveries: Array.isArray(row.deliveries)
    ? (row.deliveries as DeliveryResult[])
    : [],
});
