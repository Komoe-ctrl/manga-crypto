import { Injectable } from '@nestjs/common';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { Exchange } from '../../generated/prisma/enums.js';
import {
  ExchangeUnavailableError,
  InvalidCredentialsError,
  type ExchangeCredentials,
  type ExchangeVerifier,
  type PermissionCheck,
} from './exchange-verifier.js';

const HOST = 'api.coinbase.com';
const PATH = '/api/v3/brokerage/key_permissions';
const TIMEOUT_MS = 10_000;
const JWT_TTL_SECONDS = 120;

interface KeyPermissions {
  can_view: boolean;
  can_trade: boolean;
  can_transfer: boolean;
}

const base64url = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64url');

/**
 * Jeton JWT (ES256) d'une clé Coinbase Developer Platform : `apiKey` est le nom de la clé
 * (`organizations/…/apiKeys/…`), `apiSecret` sa clé privée PEM. Le jeton est limité à une seule requête (claim `uri`)
 * et expire en 2 minutes ; la clé privée ne sert qu'à signer.
 */
export function coinbaseJwt(
  { apiKey, apiSecret }: ExchangeCredentials,
  method: string,
  host: string,
  path: string,
  now = Date.now(),
): string {
  // Les variables d'environnement et les formulaires écrivent souvent le PEM sur une ligne avec des « \n » littéraux.
  const pem = apiSecret.replaceAll('\\n', '\n');
  const seconds = Math.floor(now / 1000);
  const header = base64url(
    JSON.stringify({
      alg: 'ES256',
      kid: apiKey,
      nonce: randomBytes(16).toString('hex'),
      typ: 'JWT',
    }),
  );
  const payload = base64url(
    JSON.stringify({
      sub: apiKey,
      iss: 'cdp',
      nbf: seconds,
      exp: seconds + JWT_TTL_SECONDS,
      uri: `${method} ${host}${path}`,
    }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(pem),
    dsaEncoding: 'ieee-p1363', // signature brute r‖s exigée par JWS, pas le DER d'OpenSSL
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

/**
 * Vérificateur Coinbase (Advanced Trade) : `GET /api/v3/brokerage/key_permissions`.
 * Coinbase n'a pas de droit « Withdrawal » distinct : `can_transfer` (envoyer des fonds hors du compte) en
 * tient lieu, et fait refuser la clé comme un droit de retrait.
 */
@Injectable()
export class CoinbaseVerifier implements ExchangeVerifier {
  readonly exchange = Exchange.COINBASE;

  async verify(
    credentials: ExchangeCredentials,
    sandbox: boolean,
  ): Promise<PermissionCheck> {
    // Advanced Trade n'a pas de testnet équivalent : même traitement que Binance, clé jamais utilisable en LIVE.
    if (sandbox)
      return {
        permissions: ['sandbox'],
        withdrawalEnabled: false,
        verified: false,
      };

    let token: string;
    try {
      token = coinbaseJwt(credentials, 'GET', HOST, PATH);
    } catch {
      // Clé privée illisible : la clé ne pourra jamais servir, inutile de réessayer.
      throw new InvalidCredentialsError();
    }

    let response: Response;
    try {
      response = await fetch(`https://${HOST}${PATH}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ExchangeUnavailableError();
    }

    if (!response.ok) {
      if (response.status >= 500 || response.status === 429)
        throw new ExchangeUnavailableError();
      throw new InvalidCredentialsError();
    }

    const body: unknown = await response.json().catch(() => null);
    if (!isKeyPermissions(body))
      throw new ExchangeUnavailableError('Réponse inattendue de la plateforme');

    const permissions: string[] = [];
    if (body.can_view) permissions.push('read');
    if (body.can_trade) permissions.push('trade');
    if (body.can_transfer) permissions.push('transfer');

    return {
      permissions,
      withdrawalEnabled: body.can_transfer,
      verified: true,
    };
  }
}

/** Un champ absent ne doit jamais être lu comme « pas de transfert ». */
function isKeyPermissions(value: unknown): value is KeyPermissions {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (['can_view', 'can_trade', 'can_transfer'] as const).every(
    (field) => typeof record[field] === 'boolean',
  );
}
