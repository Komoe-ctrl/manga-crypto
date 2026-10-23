import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Exchange } from '../../generated/prisma/enums.js';
import {
  ExchangeUnavailableError,
  InvalidCredentialsError,
  type ExchangeCredentials,
  type ExchangeVerifier,
  type PermissionCheck,
} from './exchange-verifier.js';

const BASE_URL = 'https://api.binance.com';
const TIMEOUT_MS = 10_000;
/** -1021 : horloge locale décalée. Ce n'est pas la faute de la clé. */
const TIMESTAMP_ERROR = -1021;

interface ApiRestrictions {
  enableReading: boolean;
  enableWithdrawals: boolean;
  enableInternalTransfer: boolean;
  enableSpotAndMarginTrading: boolean;
  enableMargin: boolean;
  enableFutures: boolean;
  permitsUniversalTransfer: boolean;
}

/**
 * Vérificateur Binance : `GET /sapi/v1/account/apiRestrictions` (requête signée HMAC-SHA256).
 * Le secret ne sert qu'à signer : il n'est ni envoyé, ni journalisé, ni inclus dans une erreur.
 */
@Injectable()
export class BinanceVerifier implements ExchangeVerifier {
  readonly exchange = Exchange.BINANCE;

  async verify(
    { apiKey, apiSecret }: ExchangeCredentials,
    sandbox: boolean,
  ): Promise<PermissionCheck> {
    // Le testnet n'expose pas cet endpoint ; ses fonds sont fictifs, aucun retrait réel n'est possible.
    if (sandbox)
      return {
        permissions: ['sandbox'],
        withdrawalEnabled: false,
        verified: false,
      };

    const query = `timestamp=${Date.now()}&recvWindow=5000`;
    const signature = createHmac('sha256', apiSecret)
      .update(query)
      .digest('hex');

    let response: Response;
    try {
      response = await fetch(
        `${BASE_URL}/sapi/v1/account/apiRestrictions?${query}&signature=${signature}`,
        {
          headers: { 'X-MBX-APIKEY': apiKey },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch {
      throw new ExchangeUnavailableError();
    }

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const code = (body as { code?: number } | null)?.code;
      // 418/429 : limite de débit ou bannissement IP ; 5xx : panne. Dans les deux cas, rien n'est conclu sur la clé.
      if (
        response.status >= 500 ||
        response.status === 418 ||
        response.status === 429 ||
        code === TIMESTAMP_ERROR
      ) {
        throw new ExchangeUnavailableError();
      }
      throw new InvalidCredentialsError();
    }

    if (!isApiRestrictions(body))
      throw new ExchangeUnavailableError('Réponse inattendue de la plateforme');

    const permissions: string[] = [];
    if (body.enableReading) permissions.push('read');
    if (body.enableSpotAndMarginTrading) permissions.push('trade');
    if (body.enableMargin) permissions.push('margin');
    if (body.enableFutures) permissions.push('futures');
    if (body.enableInternalTransfer || body.permitsUniversalTransfer)
      permissions.push('transfer');

    return {
      permissions,
      withdrawalEnabled: body.enableWithdrawals,
      verified: true,
    };
  }
}

/** Valide la forme de la réponse : un champ absent ne doit jamais être lu comme « pas de retrait ». */
function isApiRestrictions(value: unknown): value is ApiRestrictions {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    [
      'enableReading',
      'enableWithdrawals',
      'enableSpotAndMarginTrading',
    ] as const
  ).every((field) => typeof record[field] === 'boolean');
}
