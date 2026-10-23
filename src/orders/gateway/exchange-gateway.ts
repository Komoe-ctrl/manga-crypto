import type { Prisma } from '../../generated/prisma/client.js';
import type { Exchange } from '../../generated/prisma/enums.js';
import type { RejectionReason } from '../order-rules.js';

/** Clés déchiffrées, le temps d'un appel. Ne jamais les journaliser ni les copier dans une erreur. */
export interface GatewayCredentials {
  exchange: Exchange;
  apiKey: string;
  apiSecret: string;
}

export interface MarketOrderRequest {
  /** Actif de base (« BTC ») ; la paire est `<base>/USDT`. */
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: Prisma.Decimal;
  /** Identifiant idempotent, identique à chaque essai du même ordre. */
  clientOrderId: string;
}

/** État d'un ordre sur la plateforme, normalisé (indépendant de `ccxt`). */
export interface GatewayOrder {
  exchangeOrderId: string | null;
  status: 'closed' | 'open' | 'canceled' | 'rejected';
  filled: Prisma.Decimal;
  /** Prix moyen d'exécution ; null si rien n'est encore exécuté. */
  average: Prisma.Decimal | null;
  feeCost: Prisma.Decimal | null;
  feeCurrency: string | null;
}

/** Refus définitif (quantité trop faible, fonds insuffisants, clé refusée…) : inutile de réessayer. */
export class GatewayRejectedError extends Error {
  constructor(readonly reason: RejectionReason) {
    super(`Ordre refusé : ${reason}`);
    this.name = 'GatewayRejectedError';
  }
}

/** Plateforme injoignable ou en erreur transitoire : on réessaie (l'ordre a pu partir ou non, d'où la recherche avant création). */
export class GatewayUnavailableError extends Error {
  constructor() {
    super('Plateforme injoignable');
    this.name = 'GatewayUnavailableError';
  }
}

/**
 * Accès à la plateforme d'échange. Classe abstraite servant de jeton d'injection : l'implémentation `ccxt`
 * se remplace (tests, autre bibliothèque) sans toucher à l'exécution des ordres.
 */
export abstract class ExchangeGateway {
  /**
   * Retrouve un ordre par son `clientOrderId` ; `null` s'il n'existe pas. Appelé **avant** chaque création :
   * un essai précédent a pu aboutir sans qu'on en ait reçu la réponse.
   * @throws GatewayRejectedError | GatewayUnavailableError
   */
  abstract findOrder(
    credentials: GatewayCredentials,
    request: Pick<MarketOrderRequest, 'symbol' | 'clientOrderId'>,
  ): Promise<GatewayOrder | null>;

  /** @throws GatewayRejectedError | GatewayUnavailableError */
  abstract placeMarketOrder(
    credentials: GatewayCredentials,
    request: MarketOrderRequest,
  ): Promise<GatewayOrder>;
}
