import type { Prisma } from '../generated/prisma/client.js';

/** Signal du moteur d'analyse, version 1 (contrat : `docs/SPEC.md`, section 7). */
export interface Signal {
  v: 1;
  id: string;
  ts: Date;
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  /** Confiance du moteur, de 0 à 1. */
  score: number;
  /** Prix à l'analyse, chaîne décimale (informatif). */
  price: string | null;
  reason: string | null;
  indicators: Prisma.InputJsonObject | null;
}

/** Motifs de refus d'un message, enregistrés dans `signals:dead`. Codes stables. */
export type InvalidSignalReason =
  | 'missing_data'
  | 'too_large'
  | 'invalid_json'
  | 'not_an_object'
  | 'unsupported_version'
  | 'invalid_id'
  | 'invalid_ts'
  | 'ts_in_future'
  | 'invalid_symbol'
  | 'invalid_action'
  | 'invalid_score'
  | 'invalid_price'
  | 'invalid_reason'
  | 'invalid_indicators';

export type ParsedSignal =
  { ok: true; signal: Signal } | { ok: false; reason: InvalidSignalReason };

export const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_INDICATORS_BYTES = 2 * 1024;
const MAX_REASON_LENGTH = 500;
/** Tolérance d'horloge entre le moteur et l'API : un `ts` plus loin dans le futur est refusé. */
const MAX_CLOCK_SKEW_MS = 60_000;

const ID = /^[A-Za-z0-9\-_.:]{1,64}$/;
const SYMBOL = /^[A-Z0-9]{2,12}$/;
const POSITIVE_DECIMAL = /^(?!0+(\.0+)?$)\d{1,20}(\.\d{1,18})?$/;
/** Instant ISO 8601 en UTC, avec ou sans fraction de seconde : `2026-10-24T08:00:00Z`, `…08:00:00.123Z`. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * Valide un message du stream `signals`. N'accepte que ce que le contrat autorise : un message ambigu est refusé
 * (il part dans `signals:dead`) plutôt que deviné, car un signal sert à passer des ordres.
 * Les champs inconnus sont ignorés (évolution compatible).
 */
export function parseSignal(
  fields: Record<string, string>,
  now: Date = new Date(),
): ParsedSignal {
  const data = fields.data;
  if (typeof data !== 'string' || data.length === 0)
    return { ok: false, reason: 'missing_data' };
  if (Buffer.byteLength(data, 'utf8') > MAX_MESSAGE_BYTES)
    return { ok: false, reason: 'too_large' };

  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, reason: 'not_an_object' };
  const message = raw as Record<string, unknown>;

  if (message.v !== 1) return { ok: false, reason: 'unsupported_version' };
  if (typeof message.id !== 'string' || !ID.test(message.id))
    return { ok: false, reason: 'invalid_id' };

  if (typeof message.ts !== 'string' || !ISO_UTC.test(message.ts))
    return { ok: false, reason: 'invalid_ts' };
  const ts = new Date(message.ts);
  if (Number.isNaN(ts.getTime())) return { ok: false, reason: 'invalid_ts' };
  if (ts.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS)
    return { ok: false, reason: 'ts_in_future' };

  if (typeof message.symbol !== 'string' || !SYMBOL.test(message.symbol))
    return { ok: false, reason: 'invalid_symbol' };
  if (
    message.action !== 'BUY' &&
    message.action !== 'SELL' &&
    message.action !== 'HOLD'
  ) {
    return { ok: false, reason: 'invalid_action' };
  }
  if (
    typeof message.score !== 'number' ||
    !Number.isFinite(message.score) ||
    message.score < 0 ||
    message.score > 1
  ) {
    return { ok: false, reason: 'invalid_score' };
  }

  let price: string | null = null;
  if (message.price !== undefined && message.price !== null) {
    if (
      typeof message.price !== 'string' ||
      !POSITIVE_DECIMAL.test(message.price)
    ) {
      return { ok: false, reason: 'invalid_price' };
    }
    price = message.price;
  }

  let reason: string | null = null;
  if (message.reason !== undefined && message.reason !== null) {
    if (
      typeof message.reason !== 'string' ||
      message.reason.length > MAX_REASON_LENGTH
    ) {
      return { ok: false, reason: 'invalid_reason' };
    }
    reason = message.reason;
  }

  let indicators: Prisma.InputJsonObject | null = null;
  if (message.indicators !== undefined && message.indicators !== null) {
    const valid =
      typeof message.indicators === 'object' &&
      !Array.isArray(message.indicators) &&
      Buffer.byteLength(JSON.stringify(message.indicators), 'utf8') <=
        MAX_INDICATORS_BYTES;
    if (!valid) return { ok: false, reason: 'invalid_indicators' };
    indicators = message.indicators as Prisma.InputJsonObject;
  }

  return {
    ok: true,
    signal: {
      v: 1,
      id: message.id,
      ts,
      symbol: message.symbol,
      action: message.action,
      score: message.score,
      price,
      reason,
      indicators,
    },
  };
}
