import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits : taille d'IV recommandée pour GCM. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Données chiffrées, prêtes à être stockées (base64). `keyVersion` identifie la clé maître utilisée. */
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** Configuration de chiffrement absente ou invalide (détectée au démarrage). Ne contient jamais de clé. */
export class EncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionConfigError';
  }
}

/** Déchiffrement impossible : donnée altérée, mauvaise clé ou mauvais contexte (AAD). Message volontairement générique. */
export class DecryptionError extends Error {
  constructor() {
    super('Déchiffrement impossible');
    this.name = 'DecryptionError';
  }
}

/**
 * Chiffrement AES-256-GCM des secrets (clés API d'échange).
 *
 * - IV aléatoire unique par chiffrement, tag d'authentification stocké avec le chiffré.
 * - Clés maîtres lues dans `ENCRYPTION_KEY_V{n}` (32 octets en base64) ; `ENCRYPTION_ACTIVE_KEY_VERSION`
 *   désigne celle qui chiffre. Les anciennes versions restent utilisables pour déchiffrer (rotation).
 * - `aad` (données authentifiées additionnelles) lie le chiffré à son contexte, par exemple
 *   `exchange:<userId>:apiSecret` : un chiffré copié sur une autre ligne ne se déchiffre plus.
 *   L'appelant doit repasser le même `aad` au déchiffrement.
 */
@Injectable()
export class EncryptionService {
  private readonly activeVersion: number;
  private readonly keys = new Map<number, Buffer>();

  constructor(private readonly config: ConfigService) {
    const raw = this.config.get<string>('ENCRYPTION_ACTIVE_KEY_VERSION');
    const version = Number(raw);
    if (!raw || !Number.isInteger(version) || version < 1) {
      throw new EncryptionConfigError(
        'ENCRYPTION_ACTIVE_KEY_VERSION doit être un entier >= 1',
      );
    }
    this.activeVersion = version;
    // Échoue dès le démarrage si la clé active est absente ou mal formée.
    this.getKey(version);
  }

  /** Version de la clé maître utilisée pour chiffrer. */
  get activeKeyVersion(): number {
    return this.activeVersion;
  }

  encrypt(plaintext: string, aad?: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(
      ALGORITHM,
      this.getKey(this.activeVersion),
      iv,
      { authTagLength: TAG_BYTES },
    );
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.activeVersion,
    };
  }

  decrypt(payload: EncryptedPayload, aad?: string): string {
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.getKey(payload.keyVersion),
        Buffer.from(payload.iv, 'base64'),
        {
          authTagLength: TAG_BYTES,
        },
      );
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      // Une clé de version manquante est une erreur de configuration, à distinguer d'une donnée altérée.
      if (error instanceof EncryptionConfigError) throw error;
      throw new DecryptionError();
    }
  }

  /** Vrai si le chiffré n'utilise pas la clé active : à re-chiffrer lors d'une rotation. */
  needsRotation(payload: EncryptedPayload): boolean {
    return payload.keyVersion !== this.activeVersion;
  }

  private getKey(version: number): Buffer {
    const cached = this.keys.get(version);
    if (cached) return cached;

    const name = `ENCRYPTION_KEY_V${version}`;
    const raw = this.config.get<string>(name);
    if (!raw) throw new EncryptionConfigError(`${name} est absente`);
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new EncryptionConfigError(
        `${name} doit contenir ${KEY_BYTES} octets encodés en base64`,
      );
    }
    this.keys.set(version, key);
    return key;
  }
}
