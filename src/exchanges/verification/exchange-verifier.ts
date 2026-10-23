import type { Exchange } from '../../generated/prisma/enums.js';

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface PermissionCheck {
  /** Permissions relevées (« read », « trade »…), stockées dans ExchangeConfig.permissions. */
  permissions: string[];
  /** Vrai si la clé peut retirer des fonds : elle doit alors être refusée. */
  withdrawalEnabled: boolean;
  /** Faux quand les permissions n'ont pas pu être contrôlées (testnet). */
  verified: boolean;
}

/** Contrôle des permissions d'une clé auprès d'une plateforme. Une implémentation par plateforme. */
export interface ExchangeVerifier {
  readonly exchange: Exchange;
  /** @throws InvalidCredentialsError clé refusée par la plateforme ; ExchangeUnavailableError plateforme injoignable ou réponse inexploitable. */
  verify(
    credentials: ExchangeCredentials,
    sandbox: boolean,
  ): Promise<PermissionCheck>;
}

/** La plateforme a rejeté la clé (invalide, révoquée, IP non autorisée). */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Clé API refusée par la plateforme');
    this.name = 'InvalidCredentialsError';
  }
}

/** Contrôle impossible pour l'instant (réseau, limite de débit, réponse inattendue) : à réessayer, rien n'est conclu sur la clé. */
export class ExchangeUnavailableError extends Error {
  constructor(message = 'Plateforme injoignable') {
    super(message);
    this.name = 'ExchangeUnavailableError';
  }
}
