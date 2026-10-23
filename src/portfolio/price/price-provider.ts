import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Source de prix en USD. Les symboles sans prix connu sont absents du résultat ou valent `null`.
 * Classe abstraite pour servir de jeton d'injection : la source (API publique, puis cache Redis) se remplace
 * sans toucher à la valorisation.
 */
export abstract class PriceProvider {
  /** @throws PriceUnavailableError si la source est injoignable : l'appelant dégrade, il ne plante pas. */
  abstract getPrices(
    symbols: string[],
  ): Promise<Map<string, Prisma.Decimal | null>>;
}

export class PriceUnavailableError extends Error {
  constructor(message = 'Prix indisponibles') {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}
