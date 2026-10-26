import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';
import { CHANNEL_SENDERS } from './channels/channel-sender.js';
import { TelegramSender } from './channels/telegram.sender.js';
import { EmailSender } from './email/email.sender.js';
import { MailTransport, NodemailerTransport } from './email/mail-transport.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { NotificationService } from './notification.service.js';
import { NotificationsController } from './notifications.controller.js';
import { PushSender } from './push/push.sender.js';
import { PushSubscriptionService } from './push/push-subscription.service.js';
import { LibraryWebPushClient, WebPushClient } from './push/web-push.client.js';

@Module({
  controllers: [NotificationsController, AlertsController],
  providers: [
    NotificationService,
    NotificationSettingsService,
    AlertsService,
    PushSubscriptionService,
    { provide: WebPushClient, useClass: LibraryWebPushClient },
    { provide: MailTransport, useClass: NodemailerTransport },
    {
      provide: CHANNEL_SENDERS,
      inject: [
        ConfigService,
        WebPushClient,
        PushSubscriptionService,
        MailTransport,
      ],
      useFactory: (
        config: ConfigService,
        webPush: WebPushClient,
        subscriptions: PushSubscriptionService,
        mail: MailTransport,
      ) => [
        new TelegramSender(config),
        new PushSender(config, webPush, subscriptions),
        new EmailSender(config, mail),
      ],
    },
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
