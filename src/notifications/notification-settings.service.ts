import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  NotificationSettingsDto,
  UpdateNotificationSettingsDto,
} from './dto/notifications.dto.js';

const FIELDS = [
  'nightModeEnabled',
  'nightStartMinute',
  'nightEndMinute',
  'digestEnabled',
  'digestMinute',
  'pushEnabled',
  'telegramEnabled',
  'emailEnabled',
  'telegramChatId',
  'notificationEmail',
] as const;

const SELECT = Object.fromEntries(FIELDS.map((f) => [f, true])) as Record<
  (typeof FIELDS)[number],
  true
>;

/** Réglages de notification : Mode Nuit, heure du rapport du matin, canaux. */
@Injectable()
export class NotificationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string): Promise<NotificationSettingsDto> {
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { userId },
      select: SELECT,
    });
    if (!settings) throw new NotFoundException();
    return settings;
  }

  /**
   * Met à jour les champs fournis. Refus (422) d'une plage de Mode Nuit vide et d'un canal Telegram activé sans
   * conversation. L'audit ne garde que le nom des champs modifiés, jamais leur valeur (adresse, identifiant Telegram).
   */
  async update(
    userId: string,
    dto: UpdateNotificationSettingsDto,
    ctx: RequestContext,
  ): Promise<NotificationSettingsDto> {
    const current = await this.get(userId);
    const merged = { ...current };
    const data: Partial<NotificationSettingsDto> = {};

    for (const field of FIELDS) {
      const next = dto[field];
      if (next === undefined || next === current[field]) continue;
      (merged as Record<string, unknown>)[field] = next;
      (data as Record<string, unknown>)[field] = next;
    }

    if (
      merged.nightModeEnabled &&
      merged.nightStartMinute === merged.nightEndMinute
    ) {
      throw new UnprocessableEntityException(
        'La plage du Mode Nuit doit avoir une durée (début et fin différents)',
      );
    }
    if (merged.telegramEnabled && !merged.telegramChatId) {
      throw new UnprocessableEntityException(
        'Renseignez telegramChatId pour activer Telegram',
      );
    }

    const changed = Object.keys(data);
    if (changed.length === 0) return current;

    const updated = await this.prisma.notificationSettings.update({
      where: { userId },
      data,
      select: SELECT,
    });
    await this.audit.log({
      userId,
      action: 'notification_settings.updated',
      entityType: 'NotificationSettings',
      metadata: { fields: changed },
      ...ctx,
    });
    return updated;
  }
}
