// Génère une paire de clés VAPID pour le Web Push : `npm run vapid:generate`.
// La clé PRIVÉE est un secret (comme JWT_ACCESS_SECRET) : elle va dans .env, jamais dans git ni dans une conversation.
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('# À copier dans .env (la clé privée est secrète) :');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(
  'VAPID_SUBJECT=mailto:vous@example.com   # une adresse où les services Push peuvent vous joindre',
);
