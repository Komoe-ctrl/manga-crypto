import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  /** Texte brut uniquement : pas de HTML, donc rien à injecter ni à assainir. */
  text: string;
}

/** Erreur d'envoi réduite à un code : le message d'un serveur SMTP peut citer l'adresse, l'utilisateur ou le serveur. */
export class MailError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MailError';
  }
}

/** Envoi d'un email. Classe abstraite servant de jeton d'injection : un faux dans les tests. */
export abstract class MailTransport {
  /** @throws MailError avec un code court (`email_not_configured`, `email_auth_failed`, …). */
  abstract send(message: MailMessage): Promise<void>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * SMTP via `nodemailer`. Réglages : `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER` et `SMTP_PASS` (facultatifs),
 * `SMTP_SECURE` (TLS dès la connexion, par défaut vrai sur le port 465), `EMAIL_FROM`.
 *
 * Le chiffrement est **exigé** (STARTTLS au minimum) sauf vers la machine locale : sans cela, le mot de passe SMTP
 * circulerait en clair. `SMTP_REQUIRE_TLS=false` permet de le désactiver explicitement (serveur interne).
 */
@Injectable()
export class NodemailerTransport extends MailTransport {
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {
    super();
  }

  /** Vrai si l'envoi est configuré (hôte et expéditeur). */
  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('SMTP_HOST')?.trim() &&
      this.config.get<string>('EMAIL_FROM')?.trim(),
    );
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.isConfigured()) throw new MailError('email_not_configured');
    try {
      await this.getTransporter().sendMail(message);
    } catch (error) {
      throw new MailError(toCode(error));
    }
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    const host = this.config.get<string>('SMTP_HOST')!.trim();
    const port = Number(this.config.get('SMTP_PORT') ?? 587);
    const secureSetting = this.config.get<string>('SMTP_SECURE');
    const secure = secureSetting ? secureSetting === 'true' : port === 465;
    const tlsSetting = this.config.get<string>('SMTP_REQUIRE_TLS');
    const requireTLS = tlsSetting
      ? tlsSetting !== 'false'
      : !LOCAL_HOSTS.has(host.toLowerCase());
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    this.transporter = createTransport({
      host,
      port,
      secure,
      requireTLS: !secure && requireTLS,
      // Un serveur local de développement n'a pas de TLS : on n'en exige pas non plus de lui.
      ignoreTLS: !secure && !requireTLS,
      ...(user && pass && { auth: { user, pass } }),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    return this.transporter;
  }
}

/** Réduit une erreur nodemailer à un code stable, sans jamais en reprendre le texte. */
export function toCode(error: unknown): string {
  const e = error as { code?: unknown; responseCode?: unknown };
  if (e.code === 'EAUTH') return 'email_auth_failed';
  if (
    e.code === 'ECONNECTION' ||
    e.code === 'ETIMEDOUT' ||
    e.code === 'ESOCKET' ||
    e.code === 'EDNS' ||
    e.code === 'ECONNREFUSED'
  )
    return 'email_unreachable';
  if (typeof e.responseCode === 'number') {
    if (e.responseCode >= 500) return 'email_rejected';
    if (e.responseCode >= 400) return 'email_temporary_failure';
  }
  return 'email_error';
}
