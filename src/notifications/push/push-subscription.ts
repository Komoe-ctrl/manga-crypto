/** Un appareil abonné au Web Push (un navigateur). Stocké dans `NotificationSettings.pushSubscription` (JSON). */
export interface PushSubscriptionRecord {
  /** URL du service Push du navigateur : une capacité secrète (qui la connaît peut écrire à cet appareil). */
  endpoint: string;
  /** Clé publique du navigateur (base64url, 65 octets décodés). */
  p256dh: string;
  /** Secret d'authentification du navigateur (base64url, 16 octets décodés). */
  auth: string;
  createdAt: string;
}

/** Appareils par utilisateur : un téléphone, un ordinateur, un second navigateur. */
export const MAX_PUSH_SUBSCRIPTIONS = 5;

/**
 * Services Push des navigateurs. L'API envoie une requête HTTP vers l'adresse fournie par l'utilisateur : sans liste
 * blanche, c'est une faille SSRF (faire appeler à notre serveur une adresse interne). On n'accepte donc que les
 * services Push publics connus, en https.
 */
const ALLOWED_HOSTS = new Set([
  'fcm.googleapis.com', // Chrome, Edge, Brave, Opera (Android et ordinateur)
  'android.googleapis.com', // anciens abonnements Chrome
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari
]);
const ALLOWED_SUFFIXES = [
  '.push.services.mozilla.com', // Firefox (autres régions)
  '.notify.windows.com', // Edge historique, Windows
  '.push.apple.com', // Safari
];

/** Vrai si l'URL est un service Push connu : https, port 443, sans identifiants, hôte nommé et autorisé. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return (
    ALLOWED_HOSTS.has(host) ||
    ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

/** Clés d'un navigateur : p256dh est un point P-256 non compressé (65 octets, préfixe 0x04), auth fait 16 octets. */
export function hasValidKeys(p256dh: string, auth: string): boolean {
  const key = Buffer.from(p256dh, 'base64url');
  return (
    key.length === 65 &&
    key[0] === 0x04 &&
    Buffer.from(auth, 'base64url').length === 16
  );
}

/** Relit la colonne JSON en écartant tout ce qui n'a pas la bonne forme (donnée ancienne ou corrompue). */
export function parseSubscriptions(value: unknown): PushSubscriptionRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PushSubscriptionRecord =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as PushSubscriptionRecord).endpoint === 'string' &&
      typeof (item as PushSubscriptionRecord).p256dh === 'string' &&
      typeof (item as PushSubscriptionRecord).auth === 'string',
  );
}
