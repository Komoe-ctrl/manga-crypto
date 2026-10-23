import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '../generated/prisma/enums.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';
import { CHANNEL_SENDERS } from './channels/channel-sender.js';
import { TelegramSender } from './channels/telegram.sender.js';
import { UnavailableSender } from './channels/unavailable.sender.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { NotificationService } from './notification.service.js';
import { NotificationsController } from './notifications.controller.js';

@Module({
  controllers: [NotificationsController, AlertsController],
  providers: [
    NotificationService,
    NotificationSettingsService,
    AlertsService,
    {
      provide: CHANNEL_SENDERS,
      inject: [ConfigService],
      // Push et Email : en attente d'une dépendance validée (web-push, nodemailer).
      useFactory: (config: ConfigService) => [
        new TelegramSender(config),
        new UnavailableSender(NotificationChannel.PUSH),
        new UnavailableSender(NotificationChannel.EMAIL),
      ],
    },
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
