import type { NotificationChannel } from '../../generated/prisma/enums.js';
import type {
  ChannelMessage,
  ChannelRecipient,
  ChannelSender,
  DeliveryResult,
} from './channel-sender.js';

/**
 * Canal sans envoyeur : Push (Web Push) et Email (SMTP) demandent une dépendance hors de la stack de la SPEC,
 * à valider d'abord. La notification reste dans la boîte de réception ; la livraison est marquée en échec
 * avec un code explicite plutôt que silencieusement ignorée.
 */
export class UnavailableSender implements ChannelSender {
  constructor(readonly channel: NotificationChannel) {}

  send(
    _message: ChannelMessage,
    _recipient: ChannelRecipient,
  ): Promise<DeliveryResult> {
    return Promise.resolve({
      channel: this.channel,
      status: 'FAILED',
      reason: 'channel_not_implemented',
    });
  }
}
