import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';

/** Devise de cotation de toutes les paires (`BTC/USDT`) : un seul marché pour l'instant. */
export const QUOTE = 'USDT';
/** Frais simulés en mode PAPER : 0,1 %, comme un ordre au marché standard sur Binance. */
export const PAPER_FEE_RATE = '0.001';

/** Symboles valorisés à 1 USD : ni achetables ni vendables (pas de paire `USDT/USDT`). */
export const STABLECOINS = new Set(['USD', 'USDT', 'USDC', 'FDUSD', 'DAI']);

/** « BTC » → « BTC/USDT ». */
export const toPair = (symbol: string): string => `${symbol}/${QUOTE}`;

/**
 * Identifiant idempotent envoyé à la plateforme : généré **avant** tout appel et conservé pour tous les essais
 * d'un même ordre, il garantit qu'un retry ne passe jamais un ordre en double. 35 caractères (limite Binance : 36).
 */
export const newClientOrderId = (): string =>
  `vl-${randomUUID().replaceAll('-', '')}`;

/** Frais PAPER d'un ordre : 0,1 % de sa valeur, arrondis à 8 décimales. */
export const paperFee = (notional: Prisma.Decimal): Prisma.Decimal =>
  notional.mul(PAPER_FEE_RATE).toDecimalPlaces(8);

/** Motifs de refus d'un ordre, enregistrés dans `TradeLog.failureReason` (codes stables, lisibles par le front). */
export const REJECTION_MESSAGES = {
  kill_switch: 'Le robot est arrêté (kill switch actif)',
  paused_daily_loss:
    'Le robot est en pause : perte journalière maximale atteinte',
  manual_orders_paper_only:
    'Les ordres manuels ne sont disponibles qu’en mode PAPER',
  symbol_not_tradable: 'Ce symbole ne peut pas être négocié',
  price_unavailable: 'Prix indisponible : réessayez dans un instant',
  capital_unknown:
    'Capital total non calculable (un prix manque) : aucun ordre n’est passé à l’aveugle',
  exposure_exceeded: 'Exposition maximale par position dépassée',
  insufficient_funds: 'Fonds insuffisants',
  insufficient_quantity: 'Quantité insuffisante pour cette vente',
  no_verified_exchange:
    'Aucune configuration d’échange active, vérifiée et hors testnet',
  mode_changed: 'Le mode de trading a changé depuis la création de l’ordre',
  below_minimum: 'Quantité inférieure au minimum de la plateforme',
  invalid_order: 'Ordre refusé par la plateforme',
  invalid_symbol: 'Paire inconnue de la plateforme',
  exchange_auth: 'Clé API refusée par la plateforme',
  retries_exhausted: 'La plateforme est restée injoignable : ordre abandonné',
} as const;

export type RejectionReason = keyof typeof REJECTION_MESSAGES;

export const isRejectionReason = (
  value: string | null,
): value is RejectionReason => value !== null && value in REJECTION_MESSAGES;
