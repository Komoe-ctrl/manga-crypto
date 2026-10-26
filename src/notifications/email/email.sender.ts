import type { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '../../generated/prisma/enums.js';
import type {
  ChannelMessage,
  ChannelRecipient,
  ChannelSender,
  DeliveryResult,
} from '../channels/channel-sender.js';
import { MailError, type MailTransport } from './mail-transport.js';

const MAX_SUBJECT = 150;
const MAX_BODY = 4000;

/**
 * Email en texte brut. Le sujet est nettoyé des retours à la ligne (injection d'en-têtes), les erreurs SMTP sont
 * réduites à un code (jamais le texte du serveur) et le mot de passe SMTP n'apparaît nulle part.
 */
export class EmailSender implements ChannelSender {
  readonly channel = NotificationChannel.EMAIL;

  constructor(
    private readonly config: ConfigService,
    private readonly transport: MailTransport,
  ) {}

  async send(
    message: ChannelMessage,
    recipient: ChannelRecipient,
  ): Promise<DeliveryResult> {
    const from = this.config.get<string>('EMAIL_FROM')?.trim();
    if (!this.config.get<string>('SMTP_HOST')?.trim() || !from)
      return failed('email_not_configured');
    if (!recipient.email) return failed('email_no_recipient');

    const prefix = message.critical ? '[Critique] ' : '';
    const subject = `${prefix}${message.title}`
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, MAX_SUBJECT);
    const text = `${message.body.slice(0, MAX_BODY)}\n\n-- \nVeille`;

    try {
      await this.transport.send({ from, to: recipient.email, subject, text });
      return { channel: this.channel, status: 'SENT' };
    } catch (error) {
      return failed(error instanceof MailError ? error.code : 'email_error');
    }
  }
}

const failed = (reason: string): DeliveryResult => ({
  channel: NotificationChannel.EMAIL,
  status: 'FAILED',
  reason,
});
