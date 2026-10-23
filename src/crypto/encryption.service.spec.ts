import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import {
  DecryptionError,
  EncryptionConfigError,
  EncryptionService,
  type EncryptedPayload,
} from './encryption.service.js';

const key = () => randomBytes(32).toString('base64');

const build = (env: Record<string, string | undefined>) =>
  new EncryptionService(new ConfigService(env));

describe('EncryptionService', () => {
  const v1 = key();
  const v2 = key();
  const service = build({
    ENCRYPTION_ACTIVE_KEY_VERSION: '1',
    ENCRYPTION_KEY_V1: v1,
  });

  it('chiffre puis déchiffre', () => {
    const payload = service.encrypt('secret-binance');
    expect(payload.keyVersion).toBe(1);
    expect(payload.ciphertext).not.toContain('secret-binance');
    expect(service.decrypt(payload)).toBe('secret-binance');
  });

  it('gère les caractères Unicode et la chaîne vide', () => {
    expect(service.decrypt(service.encrypt('clé-€-🔑'))).toBe('clé-€-🔑');
    expect(service.decrypt(service.encrypt(''))).toBe('');
  });

  it('utilise un IV unique à chaque chiffrement', () => {
    const a = service.encrypt('même texte');
    const b = service.encrypt('même texte');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('produit un IV de 12 octets et un tag de 16 octets', () => {
    const payload = service.encrypt('x');
    expect(Buffer.from(payload.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(payload.authTag, 'base64')).toHaveLength(16);
  });

  it('rejette un chiffré altéré', () => {
    const payload = service.encrypt('secret');
    const bytes = Buffer.from(payload.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    expect(() =>
      service.decrypt({ ...payload, ciphertext: bytes.toString('base64') }),
    ).toThrow(DecryptionError);
  });

  it('rejette un tag altéré', () => {
    const payload = service.encrypt('secret');
    const tag = Buffer.from(payload.authTag, 'base64');
    tag[0] ^= 0xff;
    expect(() =>
      service.decrypt({ ...payload, authTag: tag.toString('base64') }),
    ).toThrow(DecryptionError);
  });

  it('lie le chiffré à son contexte (AAD)', () => {
    const payload = service.encrypt('secret', 'exchange:user-1:apiSecret');
    expect(service.decrypt(payload, 'exchange:user-1:apiSecret')).toBe(
      'secret',
    );
    expect(() => service.decrypt(payload, 'exchange:user-2:apiSecret')).toThrow(
      DecryptionError,
    );
    expect(() => service.decrypt(payload)).toThrow(DecryptionError);
  });

  it("n'expose pas le texte clair dans l'erreur de déchiffrement", () => {
    const payload: EncryptedPayload = {
      ...service.encrypt('très-secret'),
      authTag: Buffer.alloc(16).toString('base64'),
    };
    try {
      service.decrypt(payload);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('très-secret');
    }
  });

  describe('rotation des clés', () => {
    const rotated = build({
      ENCRYPTION_ACTIVE_KEY_VERSION: '2',
      ENCRYPTION_KEY_V1: v1,
      ENCRYPTION_KEY_V2: v2,
    });

    it('chiffre avec la clé active', () => {
      expect(rotated.activeKeyVersion).toBe(2);
      expect(rotated.encrypt('x').keyVersion).toBe(2);
    });

    it('déchiffre encore les données chiffrées avec une ancienne version', () => {
      const old = service.encrypt('ancien secret');
      expect(rotated.decrypt(old)).toBe('ancien secret');
      expect(rotated.needsRotation(old)).toBe(true);
      expect(rotated.needsRotation(rotated.encrypt('x'))).toBe(false);
    });

    it('signale une version de clé inconnue comme une erreur de configuration', () => {
      const payload = { ...service.encrypt('x'), keyVersion: 9 };
      expect(() => rotated.decrypt(payload)).toThrow(EncryptionConfigError);
    });
  });

  describe('validation de la configuration', () => {
    it('refuse une version active absente ou invalide', () => {
      expect(() => build({ ENCRYPTION_KEY_V1: v1 })).toThrow(
        EncryptionConfigError,
      );
      expect(() =>
        build({ ENCRYPTION_ACTIVE_KEY_VERSION: '0', ENCRYPTION_KEY_V0: v1 }),
      ).toThrow(EncryptionConfigError);
      expect(() => build({ ENCRYPTION_ACTIVE_KEY_VERSION: 'abc' })).toThrow(
        EncryptionConfigError,
      );
    });

    it('refuse une clé active absente', () => {
      expect(() => build({ ENCRYPTION_ACTIVE_KEY_VERSION: '1' })).toThrow(
        EncryptionConfigError,
      );
    });

    it('refuse une clé qui ne fait pas 32 octets sans la révéler', () => {
      const short = randomBytes(16).toString('base64');
      try {
        build({ ENCRYPTION_ACTIVE_KEY_VERSION: '1', ENCRYPTION_KEY_V1: short });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(EncryptionConfigError);
        expect((error as Error).message).not.toContain(short);
      }
    });
  });
});
