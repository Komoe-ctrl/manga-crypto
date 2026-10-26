import type { NotificationChannel } from '../../generated/prisma/enums.js';
import type { PushSubscriptionRecord } from '../push/push-subscription.js';

export interface ChannelMessage {
  title: string;
  body: string;
  critical: boolean;
}

export interface ChannelRecipient {
  userId: string;
  telegramChatId: string | null;
  email: string;
  /** Appareils abonnés au Web Push (vide si aucun). */
  pushSubscriptions: PushSubscriptionRecord[];
}

/** Résultat d'envoi sur un canal ; `reason` est un code court, jamais un message de la plateforme (il pourrait contenir un secret). */
export interface DeliveryResult {
  channel: NotificationChannel;
  status: 'SENT' | 'FAILED';
  reason?: string;
}

/** Envoi d'une notification sur un canal. Une implémentation par canal. */
export interface ChannelSender {
  readonly channel: NotificationChannel;
  /** Ne lève jamais : un échec est un `DeliveryResult` `FAILED` avec un code. */
  send(
    message: ChannelMessage,
    recipient: ChannelRecipient,
  ): Promise<DeliveryResult>;
}

/** Jeton d'injection de la liste des envoyeurs. */
export const CHANNEL_SENDERS = Symbol('CHANNEL_SENDERS');
