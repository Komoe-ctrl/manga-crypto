import { createECDH, randomBytes } from 'node:crypto';

/** Clés d'abonnement Web Push réalistes : un vrai point P-256 (65 octets) et un secret de 16 octets, en base64url. */
export function pushKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

let counter = 0;

/** Un abonnement dont l'adresse est un service Push autorisé (Chrome). */
export function chromeSubscription() {
  counter += 1;
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/device-${counter}`,
    ...pushKeys(),
  };
}
