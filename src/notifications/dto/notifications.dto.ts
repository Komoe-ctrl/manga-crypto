import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  NotificationChannel,
  NotificationStatus,
} from '../../generated/prisma/enums.js';

const MINUTE = { min: 0, max: 1439 } as const;

/** PATCH partiel : seuls les champs fournis changent ; `null` efface `telegramChatId` et `notificationEmail`. */
export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() nightModeEnabled?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1439,
    description: 'Début du Mode Nuit, en minutes depuis minuit (22:00 = 1320)',
  })
  @IsOptional()
  @IsInt()
  @Min(MINUTE.min)
  @Max(MINUTE.max)
  nightStartMinute?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1439,
    description: 'Fin du Mode Nuit, en minutes depuis minuit (07:00 = 420)',
  })
  @IsOptional()
  @IsInt()
  @Min(MINUTE.min)
  @Max(MINUTE.max)
  nightEndMinute?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() digestEnabled?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1439,
    description:
      'Heure du rapport du matin, en minutes depuis minuit (08:00 = 480)',
  })
  @IsOptional()
  @IsInt()
  @Min(MINUTE.min)
  @Max(MINUTE.max)
  digestMinute?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() pushEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() telegramEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() emailEnabled?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Identifiant de conversation Telegram (numérique)',
  })
  @IsOptional()
  @Matches(/^-?\d{1,20}$/, { message: 'telegramChatId doit être numérique' })
  telegramChatId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: "Adresse d'envoi si différente de celle du compte",
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  notificationEmail?: string | null;
}

export class NotificationSettingsDto {
  @ApiProperty() nightModeEnabled: boolean;
  @ApiProperty() nightStartMinute: number;
  @ApiProperty() nightEndMinute: number;
  @ApiProperty() digestEnabled: boolean;
  @ApiProperty() digestMinute: number;
  @ApiProperty() pushEnabled: boolean;
  @ApiProperty() telegramEnabled: boolean;
  @ApiProperty() emailEnabled: boolean;
  @ApiProperty({ nullable: true, type: String }) telegramChatId: string | null;
  @ApiProperty({ nullable: true, type: String }) notificationEmail:
    string | null;
}

export class DeliveryDto {
  @ApiProperty({ enum: Object.values(NotificationChannel) })
  channel: NotificationChannel;
  @ApiProperty({ enum: ['SENT', 'FAILED'] }) status: string;
  @ApiPropertyOptional({
    description:
      "Code court de l'échec (ex. telegram_not_configured, channel_not_implemented)",
  })
  reason?: string;
}

export class NotificationDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() body: string;
  @ApiProperty() critical: boolean;
  @ApiProperty({
    enum: Object.values(NotificationStatus),
    description:
      'HELD : mise en attente par le Mode Nuit ; DIGESTED : reprise dans un rapport du matin (voir digestId)',
  })
  status: NotificationStatus;
  @ApiProperty({ type: [DeliveryDto] }) deliveries: DeliveryDto[];
  @ApiProperty({ nullable: true, type: Date }) readAt: Date | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Rapport du matin qui a repris cette notification (statut DIGESTED)',
  })
  digestId: string | null;
  @ApiProperty() createdAt: Date;
}

export class NotificationListDto {
  @ApiProperty({ type: [NotificationDto] }) items: NotificationDto[];
  @ApiProperty() unreadCount: number;
}

export class ListNotificationsQuery {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Pagination : notifications créées avant cette date (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601()
  before?: string;

  @ApiPropertyOptional({ description: 'Ne renvoyer que les non lues' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  unread?: boolean;
}
