import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Exchange } from '../../generated/prisma/enums.js';
import { BinanceVerifier } from './binance.verifier.js';
import { CoinbaseVerifier } from './coinbase.verifier.js';
import type { ExchangeVerifier } from './exchange-verifier.js';

/**
 * Associe chaque plateforme à son vérificateur. Une plateforme sans vérificateur est refusée :
 * CCXT n'expose pas les permissions de façon uniforme (SPEC section 4.2).
 */
@Injectable()
export class VerifierRegistry {
  private readonly verifiers: Map<Exchange, ExchangeVerifier>;

  constructor(binance: BinanceVerifier, coinbase: CoinbaseVerifier) {
    this.verifiers = new Map<Exchange, ExchangeVerifier>([
      [binance.exchange, binance],
      [coinbase.exchange, coinbase],
    ]);
  }

  get(exchange: Exchange): ExchangeVerifier {
    const verifier = this.verifiers.get(exchange);
    if (!verifier) {
      throw new UnprocessableEntityException(
        `Plateforme ${exchange} non supportée : aucun vérificateur de permissions disponible`,
      );
    }
    return verifier;
  }
}
