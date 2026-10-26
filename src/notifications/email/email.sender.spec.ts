import type { ConfigService } from '@nestjs/config';
import type { ChannelRecipient } from '../channels/channel-sender.js';
import { EmailSender } from './email.sender.js';
import {
  MailError,
  MailTransport,
  toCode,
  type MailMessage,
} from './mail-transport.js';

class FakeTransport extends MailTransport {
  sent: MailMessage[] = [];
  failure?: Error;

  send(message: MailMessage): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.sent.push(message);
    return Promise.resolve();
  }
}

const ENV = {
  SMTP_HOST: 'smtp.example.com',
  EMAIL_FROM: 'Veille <veille@example.com>',
};

function build(env: Record<string, string> = ENV) {
  const transport = new FakeTransport();
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return { transport, sender: new EmailSender(config, transport) };
}

const recipient: ChannelRecipient = {
  userId: 'u1',
  telegramChatId: null,
  email: 'client@example.com',
  pushSubscriptions: [],
};

describe('EmailSender', () => {
  it('envoie un texte brut au destinataire, depuis l’expéditeur configuré', async () => {
    const { sender, transport } = build();

    const result = await sender.send(
      {
        title: 'Rapport du matin',
        body: 'Portefeuille : +1,2 %',
        critical: false,
      },
      recipient,
    );

    expect(result).toEqual({ channel: 'EMAIL', status: 'SENT' });
    expect(transport.sent).toEqual([
      {
        from: 'Veille <veille@example.com>',
        to: 'client@example.com',
        subject: 'Rapport du matin',
        text: 'Portefeuille : +1,2 %\n\n-- \nVeille',
      },
    ]);
  });

  it('préfixe le sujet d’un message critique', async () => {
    const { sender, transport } = build();
    await sender.send(
      { title: 'Stop-loss exécuté', body: '…', critical: true },
      recipient,
    );
    expect(transport.sent[0].subject).toBe('[Critique] Stop-loss exécuté');
  });

  it('nettoie le sujet des retours à la ligne (injection d’en-têtes) et le borne', async () => {
    const { sender, transport } = build();
    await sender.send(
      {
        title: 'Salut\r\nBcc: victime@example.com\nX-Test: 1',
        body: 'b',
        critical: false,
      },
      recipient,
    );
    expect(transport.sent[0].subject).not.toMatch(/[\r\n]/);
    expect(transport.sent[0].subject).toBe(
      'Salut Bcc: victime@example.com X-Test: 1',
    );

    await sender.send(
      { title: 'x'.repeat(500), body: 'b', critical: false },
      recipient,
    );
    expect(transport.sent[1].subject).toHaveLength(150);
  });

  it('borne la taille du texte', async () => {
    const { sender, transport } = build();
    await sender.send(
      { title: 't', body: 'b'.repeat(10_000), critical: false },
      recipient,
    );
    expect(transport.sent[0].text.length).toBeLessThan(4100);
  });

  it.each([
    ['sans serveur SMTP', { EMAIL_FROM: 'a@example.com' }],
    ['sans expéditeur', { SMTP_HOST: 'smtp.example.com' }],
    ['sans rien', {}],
  ])('%s : email_not_configured, rien n’est envoyé', async (_label, env) => {
    const { sender, transport } = build(env);
    await expect(
      sender.send({ title: 't', body: 'b', critical: false }, recipient),
    ).resolves.toEqual({
      channel: 'EMAIL',
      status: 'FAILED',
      reason: 'email_not_configured',
    });
    expect(transport.sent).toEqual([]);
  });

  it('sans destinataire : email_no_recipient', async () => {
    const { sender, transport } = build();
    await expect(
      sender.send(
        { title: 't', body: 'b', critical: false },
        { ...recipient, email: '' },
      ),
    ).resolves.toMatchObject({ reason: 'email_no_recipient' });
    expect(transport.sent).toEqual([]);
  });

  it.each([
    [new MailError('email_auth_failed'), 'email_auth_failed'],
    [new MailError('email_unreachable'), 'email_unreachable'],
    [new Error('quelque chose'), 'email_error'],
  ])('une erreur d’envoi devient un code court (%#)', async (error, reason) => {
    const { sender, transport } = build();
    transport.failure = error;
    await expect(
      sender.send({ title: 't', body: 'b', critical: false }, recipient),
    ).resolves.toEqual({ channel: 'EMAIL', status: 'FAILED', reason });
  });

  it('ne révèle ni le mot de passe ni le texte du serveur SMTP', async () => {
    const { sender, transport } = build({ ...ENV });
    transport.failure = new Error(
      '535 5.7.8 Authentication failed for user hunter2@smtp.example.com',
    );
    const result = JSON.stringify(
      await sender.send({ title: 't', body: 'b', critical: false }, recipient),
    );
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('535');
  });
});

describe('toCode (erreurs nodemailer)', () => {
  it.each([
    [{ code: 'EAUTH', response: '535 mot de passe' }, 'email_auth_failed'],
    [{ code: 'ECONNECTION' }, 'email_unreachable'],
    [{ code: 'ETIMEDOUT' }, 'email_unreachable'],
    [{ code: 'ESOCKET' }, 'email_unreachable'],
    [{ code: 'EDNS' }, 'email_unreachable'],
    [{ code: 'ECONNREFUSED' }, 'email_unreachable'],
    [{ code: 'EENVELOPE', responseCode: 550 }, 'email_rejected'],
    [{ responseCode: 421 }, 'email_temporary_failure'],
    [{ responseCode: 452 }, 'email_temporary_failure'],
    [{}, 'email_error'],
    [new Error('autre'), 'email_error'],
    [null, 'email_error'],
  ])('%j → %s', (error, code) => {
    expect(toCode(error ?? {})).toBe(code);
  });
});
