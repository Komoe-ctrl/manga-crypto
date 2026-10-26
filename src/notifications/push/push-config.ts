import type { ConfigService } from '@nestjs/config';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** « mailto:… » ou une adresse https : à qui le service Push peut s'adresser en cas de problème. */
  subject: string;
}

/**
 * Clés VAPID du serveur (variables d'environnement), ou `null` si le Push n'est pas configuré. Un sujet qui n'est
 * ni `mailto:` ni `https:` est refusé par les services Push : mieux vaut le signaler tout de suite par
 * `push_not_configured` que découvrir des refus 403 à chaque envoi.
 */
export function pushConfig(config: ConfigService): VapidConfig | null {
  const publicKey = config.get<string>('VAPID_PUBLIC_KEY')?.trim();
  const privateKey = config.get<string>('VAPID_PRIVATE_KEY')?.trim();
  const subject = config.get<string>('VAPID_SUBJECT')?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}
