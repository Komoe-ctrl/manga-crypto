import { NotificationChannel } from '../../generated/prisma/enums.js';
import type { ConfigService } from '@nestjs/config';
import type {
  ChannelMessage,
  ChannelRecipient,
  ChannelSender,
  DeliveryResult,
} from '../channels/channel-sender.js';
import { pushConfig } from './push-config.js';
import type { PushSubscriptionService } from './push-subscription.service.js';
import { PushHttpError, type WebPushClient } from './web-push.client.js';

const MAX_TITLE = 120;
const MAX_BODY = 1000;
/** Un message critique doit être livré même si l'appareil est éteint quelques heures ; un autre perd vite sa valeur. */
const CRITICAL_TTL_SECONDS = 24 * 60 * 60;
const NORMAL_TTL_SECONDS = 60 * 60;

/**
 * Web Push : un message chiffré par appareil abonné. Ni l'adresse d'un appareil, ni ses clés, ni le message
 * d'erreur d'un service Push (qui peut contenir l'adresse) ne sont journalisés ou renvoyés : seuls des codes courts.
 * Un appareil dont l'abonnement est révoqué (404 ou 410) est retiré tout de suite.
 */
export class PushSender implements ChannelSender {
  readonly channel = NotificationChannel.PUSH;

  constructor(
    private readonly config: ConfigService,
    private readonly client: WebPushClient,
    private readonly subscriptions: PushSubscriptionService,
  ) {}

  async send(
    message: ChannelMessage,
    recipient: ChannelRecipient,
  ): Promise<DeliveryResult> {
    const vapid = pushConfig(this.config);
    if (!vapid) return failed('push_not_configured');
    if (recipient.pushSubscriptions.length === 0)
      return failed('push_no_subscription');

    // Lu par le service worker du front (voir SPEC section 9).
    const payload = JSON.stringify({
      title: message.title.slice(0, MAX_TITLE),
      body: message.body.slice(0, MAX_BODY),
      critical: message.critical,
    });
    const options = {
      ttlSeconds: message.critical ? CRITICAL_TTL_SECONDS : NORMAL_TTL_SECONDS,
      urgency: message.critical ? ('high' as const) : ('normal' as const),
    };

    const outcomes = await Promise.all(
      recipient.pushSubscriptions.map(async (subscription) => {
        try {
          await this.client.send(subscription, payload, vapid, options);
          return 'sent' as const;
        } catch (error) {
          if (error instanceof PushHttpError) {
            if (error.statusCode === 404 || error.statusCode === 410) {
              await this.subscriptions
                .removeExpired(recipient.userId, subscription.endpoint)
                .catch(() => undefined); // le nettoyage ne doit pas masquer le résultat de l'envoi
              return 'gone' as const;
            }
            return `push_http_${error.statusCode}`;
          }
          return 'push_unreachable';
        }
      }),
    );

    // Livré si au moins un appareil l'a reçu : un second appareil en panne ne rend pas l'alerte « échouée ».
    if (outcomes.includes('sent'))
      return { channel: this.channel, status: 'SENT' };
    if (outcomes.every((o) => o === 'gone'))
      return failed('push_subscription_gone');
    const code = outcomes.find((o) => o !== 'gone' && o !== 'sent');
    return failed(code ?? 'push_unreachable');
  }
}

const failed = (reason: string): DeliveryResult => ({
  channel: NotificationChannel.PUSH,
  status: 'FAILED',
  reason,
});
