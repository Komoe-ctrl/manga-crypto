import { hostname } from 'node:os';
import type { Redis } from 'ioredis';

export const SIGNALS_STREAM = 'signals';
export const SIGNALS_GROUP = 'api';
export const SIGNALS_DEAD_STREAM = 'signals:dead';

/** Taille maximale approximative du stream des messages refusés. */
const DEAD_STREAM_MAXLEN = 1000;
/** Contenu brut conservé dans `signals:dead` : de quoi diagnostiquer, sans recopier un message énorme. */
const DEAD_RAW_LIMIT = 2048;

export interface SignalEntry {
  /** Identifiant de l'entrée dans le stream (« 1729756800000-0 »). */
  id: string;
  fields: Record<string, string>;
}

/**
 * Accès au stream Redis `signals`. Classe abstraite servant de jeton d'injection : l'implémentation Redis en
 * production, un faux en mémoire dans les tests du consommateur.
 */
export abstract class SignalStream {
  /** Crée le groupe de consommateurs s'il n'existe pas (idempotent). */
  abstract ensureGroup(): Promise<void>;
  /** Nouveaux messages ; `blockMs <= 0` : ne bloque pas. */
  abstract readNew(count: number, blockMs: number): Promise<SignalEntry[]>;
  /** Reprend les messages livrés à un consommateur resté sans réponse (plantage) depuis plus de `minIdleMs`. */
  abstract claimStale(minIdleMs: number, count: number): Promise<SignalEntry[]>;
  /** Nombre de livraisons d'un message (une reprise l'incrémente). */
  abstract deliveryCount(entryId: string): Promise<number>;
  abstract ack(entryId: string): Promise<void>;
  /** Copie un message refusé dans `signals:dead` avec son motif (l'appelant l'acquitte ensuite). */
  abstract deadLetter(entry: SignalEntry, reason: string): Promise<void>;
  abstract close(): Promise<void>;
}

type RawEntry = [string, string[]];
/**
 * Réponse brute de `XREADGROUP`, dont la forme dépend du protocole (ioredis 6 négocie RESP3 par défaut) :
 * - RESP2 : `[[flux, [entrées]], …]` ;
 * - RESP3 : une table que `call` aplatit en `[flux, [entrées], flux, [entrées], …]`.
 * Les deux sont acceptées : se tromper de forme ferait échouer la lecture dès le premier message.
 */
type StreamReply = unknown[] | null;

/**
 * Implémentation Redis. Utilise une connexion **dédiée** : `XREADGROUP BLOCK` bloque la connexion pendant l'attente,
 * ce qui paralyserait BullMQ si elle était partagée.
 */
export class RedisSignalStream extends SignalStream {
  private readonly consumer = `api-${hostname()}-${process.pid}`;

  constructor(private readonly redis: Redis) {
    super();
  }

  async ensureGroup(): Promise<void> {
    try {
      // Depuis le début du stream : les signaux publiés avant le premier démarrage sont traités (les périmés sont ignorés).
      await this.redis.xgroup(
        'CREATE',
        SIGNALS_STREAM,
        SIGNALS_GROUP,
        '0',
        'MKSTREAM',
      );
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('BUSYGROUP')))
        throw error;
    }
  }

  async readNew(count: number, blockMs: number): Promise<SignalEntry[]> {
    const block: (string | number)[] = blockMs > 0 ? ['BLOCK', blockMs] : [];
    // `call` : le typage d'ioredis ne gère pas la partie optionnelle (BLOCK) de cette commande ; la réponse est brute.
    const reply = (await this.redis.call(
      'XREADGROUP',
      'GROUP',
      SIGNALS_GROUP,
      this.consumer,
      'COUNT',
      count,
      ...block,
      'STREAMS',
      SIGNALS_STREAM,
      '>',
    )) as StreamReply;
    return entriesOf(reply);
  }

  async claimStale(minIdleMs: number, count: number): Promise<SignalEntry[]> {
    const [, entries] = (await this.redis.xautoclaim(
      SIGNALS_STREAM,
      SIGNALS_GROUP,
      this.consumer,
      minIdleMs,
      '0-0',
      'COUNT',
      count,
    )) as [string, [string, string[]][], string[]?];
    return entries.filter(([, fields]) => fields).map(toEntry);
  }

  async deliveryCount(entryId: string): Promise<number> {
    const pending = (await this.redis.xpending(
      SIGNALS_STREAM,
      SIGNALS_GROUP,
      entryId,
      entryId,
      1,
    )) as [string, string, number, number][];
    return pending[0]?.[3] ?? 0;
  }

  async ack(entryId: string): Promise<void> {
    await this.redis.xack(SIGNALS_STREAM, SIGNALS_GROUP, entryId);
  }

  async deadLetter(entry: SignalEntry, reason: string): Promise<void> {
    await this.redis.xadd(
      SIGNALS_DEAD_STREAM,
      'MAXLEN',
      '~',
      DEAD_STREAM_MAXLEN,
      '*',
      'reason',
      reason,
      'entry',
      entry.id,
      'raw',
      JSON.stringify(entry.fields).slice(0, DEAD_RAW_LIMIT),
    );
  }

  /** Coupe la connexion (un `XREADGROUP BLOCK` en cours ne répondrait pas à un `QUIT` avant son délai). */
  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/** Entrées d'une réponse `XREADGROUP`, quel que soit le protocole (voir `StreamReply`). */
export function entriesOf(reply: StreamReply): SignalEntry[] {
  if (!Array.isArray(reply) || reply.length === 0) return [];

  const perStream: unknown[] = [];
  if (typeof reply[0] === 'string') {
    // RESP3 aplati : les entrées sont aux positions impaires.
    for (let i = 1; i < reply.length; i += 2) perStream.push(reply[i]);
  } else {
    // RESP2 : chaque élément est `[flux, entrées]`.
    for (const stream of reply)
      if (Array.isArray(stream)) perStream.push(stream[1]);
  }
  return perStream.flatMap((entries) =>
    Array.isArray(entries) ? (entries as RawEntry[]).map(toEntry) : [],
  );
}

const toEntry = ([id, flat]: [string, string[]]): SignalEntry => {
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
  return { id, fields };
};
