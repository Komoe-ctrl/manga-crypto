import { pushKeys } from '../../../test/support/push-keys.js';
import {
  hasValidKeys,
  isAllowedPushEndpoint,
  parseSubscriptions,
} from './push-subscription.js';

describe('isAllowedPushEndpoint (liste blanche contre la SSRF)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://android.googleapis.com/gcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://eu.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc',
    'https://abc.push.apple.com/3/device/abc',
    'https://db5p.notify.windows.com/?token=abc',
    'https://FCM.googleapis.com/fcm/send/abc', // la casse de l'hôte ne compte pas
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('accepte %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    // Adresses internes : le cœur de la faille SSRF.
    ['http://localhost/push', 'localhost'],
    ['https://localhost/push', 'localhost en https'],
    ['https://127.0.0.1/push', 'boucle locale'],
    ['https://169.254.169.254/latest/meta-data', 'métadonnées cloud'],
    ['https://10.0.0.5/push', 'réseau privé'],
    ['https://[::1]/push', 'IPv6 locale'],
    ['https://postgres:5432/', "service interne d'un conteneur"],
    // Détournements d'URL.
    ['http://fcm.googleapis.com/fcm/send/abc', 'http au lieu de https'],
    [
      'https://fcm.googleapis.com@evil.example/push',
      'identifiants : hôte réel evil.example',
    ],
    [
      'https://user:pass@fcm.googleapis.com/fcm/send/abc',
      'identifiants dans l’URL',
    ],
    ['https://evil.example/fcm.googleapis.com', 'nom autorisé dans le chemin'],
    ['https://fcm.googleapis.com.evil.example/push', 'nom autorisé en préfixe'],
    ['https://evilfcm.googleapis.com/push', 'sous-domaine non autorisé'],
    ['https://xnotify.windows.com/push', 'suffixe sans point'],
    ['https://fcm.googleapis.com:8443/fcm/send/abc', 'port non standard'],
    ['ftp://fcm.googleapis.com/x', 'autre protocole'],
    ['javascript:alert(1)', 'pseudo-protocole'],
    ['//fcm.googleapis.com/x', 'URL relative'],
    ['fcm.googleapis.com/x', 'sans protocole'],
    ['', 'vide'],
    ['pas une url', 'texte quelconque'],
  ])('refuse %s (%s)', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it('refuse une adresse de plus de 2048 caractères', () => {
    expect(
      isAllowedPushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(2048)}`),
    ).toBe(false);
  });
});

describe('hasValidKeys', () => {
  it('accepte de vraies clés de navigateur', () => {
    const { p256dh, auth } = pushKeys();
    expect(hasValidKeys(p256dh, auth)).toBe(true);
  });

  it.each([
    [
      'clé trop courte',
      (k: ReturnType<typeof pushKeys>) => ({
        ...k,
        p256dh: k.p256dh.slice(0, 40),
      }),
    ],
    [
      'secret trop court',
      (k: ReturnType<typeof pushKeys>) => ({ ...k, auth: k.auth.slice(0, 10) }),
    ],
    [
      'secret trop long',
      (k: ReturnType<typeof pushKeys>) => ({ ...k, auth: `${k.auth}AAAA` }),
    ],
    [
      'point non compressé mal préfixé',
      (k: ReturnType<typeof pushKeys>) => ({
        ...k,
        p256dh: Buffer.concat([
          Buffer.from([0x02]),
          Buffer.from(k.p256dh, 'base64url').subarray(1),
        ]).toString('base64url'),
      }),
    ],
    ['clé vide', (k: ReturnType<typeof pushKeys>) => ({ ...k, p256dh: '' })],
  ])('refuse %s', (_label, mutate) => {
    const { p256dh, auth } = mutate(pushKeys());
    expect(hasValidKeys(p256dh, auth)).toBe(false);
  });
});

describe('parseSubscriptions', () => {
  const good = {
    endpoint: 'https://fcm.googleapis.com/x',
    p256dh: 'a',
    auth: 'b',
    createdAt: 'c',
  };

  it('garde les abonnements bien formés et écarte le reste', () => {
    expect(
      parseSubscriptions([
        good,
        null,
        'x',
        42,
        { endpoint: 1 },
        { endpoint: 'e' },
      ]),
    ).toEqual([good]);
  });

  it.each([null, undefined, {}, 'texte', 7])(
    'renvoie une liste vide pour %j',
    (value) => {
      expect(parseSubscriptions(value)).toEqual([]);
    },
  );
});
