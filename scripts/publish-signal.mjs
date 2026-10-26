#!/usr/bin/env node
/**
 * Publie un signal dans le Redis Stream `signals` (contrat : docs/SPEC.md, section 7).
 * Outil d'essai : il joue le rôle du moteur d'analyse, qui n'émet pas encore de signaux.
 *
 *   npm run signals:publish -- --symbol BTC --action BUY --score 0.8
 *   npm run signals:publish -- --symbol BTC --action SELL --score 0.9 --id mon-signal-1
 *   npm run signals:publish -- --raw '{"pas":"valide"}'        # message brut (essai du rejet vers signals:dead)
 *
 * Options : --symbol (BTC) --action (BUY|SELL|HOLD) --score (0.8) --price (chaîne décimale) --reason --id --ts (ISO UTC)
 *           --age-seconds (date le signal dans le passé) --raw (envoie ce texte tel quel) --redis (URL)
 * L'URL de Redis vient de --redis, sinon de REDIS_URL, sinon de redis://localhost:6379.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', default: 'BTC' },
    action: { type: 'string', default: 'BUY' },
    score: { type: 'string', default: '0.8' },
    price: { type: 'string' },
    reason: { type: 'string', default: 'signal de test (scripts/publish-signal.mjs)' },
    id: { type: 'string' },
    ts: { type: 'string' },
    'age-seconds': { type: 'string' },
    raw: { type: 'string' },
    redis: { type: 'string' },
  },
});

const data =
  values.raw ??
  JSON.stringify({
    v: 1,
    id: values.id ?? randomUUID(),
    ts: values.ts ?? new Date(Date.now() - Number(values['age-seconds'] ?? 0) * 1000).toISOString(),
    symbol: values.symbol,
    action: values.action,
    score: Number(values.score),
    ...(values.price && { price: values.price }),
    reason: values.reason,
  });

const redis = new Redis(values.redis ?? process.env.REDIS_URL ?? 'redis://localhost:6379');
try {
  // Même bornage de taille que dans le contrat : le moteur doit publier ainsi.
  const entryId = await redis.xadd('signals', 'MAXLEN', '~', 10000, '*', 'data', data);
  console.log(`Publié dans signals : ${entryId}`);
  console.log(data);
} finally {
  redis.disconnect();
}
