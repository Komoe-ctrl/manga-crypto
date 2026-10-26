import { Injectable } from '@nestjs/common';
import webpush from 'web-push';
import type { VapidConfig } from './push-config.js';
import type { PushSubscriptionRecord } from './push-subscription.js';

export interface PushSendOptions {
  /** Durée de conservation par le service Push si l'appareil est éteint, en secondes. */
  ttlSeconds: number;
  urgency: 'normal' | 'high';
}

/** Erreur d'un service Push : seul le code HTTP est conservé (le message pourrait contenir l'adresse de l'appareil). */
export class PushHttpError extends Error {
  constructor(readonly statusCode: number) {
    super(`push_http_${statusCode}`);
    this.name = 'PushHttpError';
  }
}

/** Envoi d'un message Web Push chiffré. Classe abstraite servant de jeton d'injection : un faux dans les tests. */
export abstract class WebPushClient {
  /** @throws PushHttpError réponse du service Push ; toute autre erreur : problème réseau. */
  abstract send(
    subscription: PushSubscriptionRecord,
    payload: string,
    vapid: VapidConfig,
    options: PushSendOptions,
  ): Promise<void>;
}

const TIMEOUT_MS = 10_000;

/** Implémentation avec la bibliothèque `web-push` : chiffrement du message (aes128gcm) et signature VAPID. */
@Injectable()
export class LibraryWebPushClient extends WebPushClient {
  async send(
    subscription: PushSubscriptionRecord,
    payload: string,
    vapid: VapidConfig,
    options: PushSendOptions,
  ): Promise<void> {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        {
          // Les clés sont passées à chaque appel : `setVapidDetails` modifierait un état global de la bibliothèque.
          vapidDetails: {
            subject: vapid.subject,
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
          TTL: options.ttlSeconds,
          urgency: options.urgency,
          timeout: TIMEOUT_MS,
        },
      );
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number') throw new PushHttpError(status);
      throw new Error('push_unreachable');
    }
  }
}
