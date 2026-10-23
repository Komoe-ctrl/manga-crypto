import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '../../generated/prisma/enums.js';
import type {
  ChannelMessage,
  ChannelRecipient,
  ChannelSender,
  DeliveryResult,
} from './channel-sender.js';

const TIMEOUT_MS = 10_000;
/** Limite de Telegram pour un message. */
const MAX_LENGTH = 4096;

/**
 * Telegram via l'API Bot (`sendMessage`), sans dépendance. Le jeton `TELEGRAM_BOT_TOKEN` fait partie de l'URL :
 * il n'est jamais journalisé ni inclus dans un résultat, et les erreurs réseau (dont le message peut
 * contenir l'URL) sont réduites à un code.
 */
export class TelegramSender implements ChannelSender {
  readonly channel = NotificationChannel.TELEGRAM;

  constructor(private readonly config: ConfigService) {}

  async send(
    message: ChannelMessage,
    recipient: ChannelRecipient,
  ): Promise<DeliveryResult> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return failed('telegram_not_configured');
    if (!recipient.telegramChatId) return failed('telegram_no_chat');

    const prefix = message.critical ? '[Critique] ' : '';
    const text = `${prefix}${message.title}\n\n${message.body}`.slice(
      0,
      MAX_LENGTH,
    );

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: recipient.telegramChatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      return response.ok
        ? { channel: this.channel, status: 'SENT' }
        : failed(`telegram_http_${response.status}`);
    } catch {
      return failed('telegram_unreachable');
    }
  }
}

const failed = (reason: string): DeliveryResult => ({
  channel: NotificationChannel.TELEGRAM,
  status: 'FAILED',
  reason,
});
