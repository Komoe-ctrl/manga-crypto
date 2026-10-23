import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuditService } from '../audit/audit.service.js';
import { EncryptionService } from '../crypto/encryption.service.js';
import { Exchange, ExchangeStatus } from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ExchangesService } from './exchanges.service.js';
import {
  ExchangeUnavailableError,
  InvalidCredentialsError,
  type ExchangeVerifier,
  type PermissionCheck,
} from './verification/exchange-verifier.js';
import { VerifierRegistry } from './verification/verifier.registry.js';

const dto = {
  exchange: Exchange.BINANCE,
  label: 'Principal',
  apiKey: 'public-key-a1b2',
  apiSecret: 'super-secret-value',
};
const ok: PermissionCheck = {
  permissions: ['read', 'trade'],
  withdrawalEnabled: false,
  verified: true,
};

function build(initial: () => Promise<PermissionCheck> = async () => ok) {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const encryption = new EncryptionService(
    new ConfigService({
      ENCRYPTION_ACTIVE_KEY_VERSION: '1',
      ENCRYPTION_KEY_V1: randomBytes(32).toString('base64'),
    }),
  );
  const verifier = {
    exchange: Exchange.BINANCE,
    verify: vi.fn(initial),
  } satisfies ExchangeVerifier;
  const registry = new VerifierRegistry(verifier as never);
  const service = new ExchangesService(
    asPrisma,
    encryption,
    new AuditService(asPrisma),
    registry,
  );
  return { prisma, service, verifier, encryption };
}

describe('ExchangesService', () => {
  describe('create', () => {
    it('stocke la clé chiffrée et ne renvoie aucun secret', async () => {
      const { prisma, service } = build();
      const created = await service.create('user-1', dto, {});

      expect(created).toMatchObject({
        exchange: 'BINANCE',
        status: 'ACTIVE',
        permissions: ['read', 'trade'],
        apiKeyHint: 'a1b2',
      });
      const stored = JSON.stringify(prisma.exchangeConfigs);
      expect(stored).not.toContain(dto.apiKey);
      expect(stored).not.toContain(dto.apiSecret);
      expect(Object.keys(created).join()).not.toMatch(
        /cipher|Iv|Tag|secret|keyVersion/,
      );
    });

    it('chiffre avec la clé active et lie le chiffré à sa ligne (AAD)', async () => {
      const { prisma, service, encryption } = build();
      const { id } = await service.create('user-1', dto, {});
      const row = prisma.exchangeConfigs[0];

      expect(row.keyVersion).toBe(1);
      const payload = {
        ciphertext: row.apiSecretCipher,
        iv: row.apiSecretIv,
        authTag: row.apiSecretTag,
        keyVersion: 1,
      };
      expect(
        encryption.decrypt(payload, `exchange-config:${id}:apiSecret`),
      ).toBe(dto.apiSecret);
      expect(() =>
        encryption.decrypt(payload, 'exchange-config:autre-id:apiSecret'),
      ).toThrow();
    });

    it('refuse une clé avec le droit Withdrawal, sans rien stocker, et audite le refus', async () => {
      const { prisma, service } = build(async () => ({
        ...ok,
        withdrawalEnabled: true,
      }));

      await expect(service.create('user-1', dto, {})).rejects.toThrow(
        UnprocessableEntityException,
      );

      expect(prisma.exchangeConfigs).toHaveLength(0);
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'exchange.key_rejected',
        metadata: { reason: 'withdrawal' },
      });
    });

    it('refuse une clé invalide sans rien stocker', async () => {
      const { prisma, service } = build(async () => {
        throw new InvalidCredentialsError();
      });
      await expect(service.create('user-1', dto, {})).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prisma.exchangeConfigs).toHaveLength(0);
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'exchange.key_rejected',
        metadata: { reason: 'invalid_key' },
      });
    });

    it('renvoie 503 quand la plateforme est injoignable, sans conclure sur la clé', async () => {
      const { prisma, service } = build(async () => {
        throw new ExchangeUnavailableError();
      });
      await expect(service.create('user-1', dto, {})).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.exchangeConfigs).toHaveLength(0);
    });

    it('refuse une plateforme sans vérificateur, sans appeler personne', async () => {
      const { prisma, service, verifier } = build();
      await expect(
        service.create('user-1', { ...dto, exchange: Exchange.KRAKEN }, {}),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(prisma.exchangeConfigs).toHaveLength(0);
    });

    it('accepte un testnet en le marquant non vérifié', async () => {
      const { service } = build(async () => ({
        permissions: ['sandbox'],
        withdrawalEnabled: false,
        verified: false,
      }));
      const created = await service.create(
        'user-1',
        { ...dto, sandbox: true },
        {},
      );
      expect(created).toMatchObject({
        sandbox: true,
        status: 'ACTIVE',
        verifiedAt: null,
      });
      expect(created.statusReason).toMatch(/Testnet/);
    });

    it('refuse un doublon plateforme + libellé', async () => {
      const { service } = build();
      await service.create('user-1', dto, {});
      await expect(service.create('user-1', dto, {})).rejects.toThrow(
        ConflictException,
      );
    });

    it('audite l’ajout sans aucun secret', async () => {
      const { prisma, service } = build();
      await service.create('user-1', dto, { ipAddress: '1.2.3.4' });
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'exchange.key_added',
        userId: 'user-1',
        ipAddress: '1.2.3.4',
      });
      const logged = JSON.stringify(prisma.auditLogs);
      expect(logged).not.toContain(dto.apiKey);
      expect(logged).not.toContain(dto.apiSecret);
    });
  });

  describe('list', () => {
    it('ne renvoie que les configurations de l’utilisateur', async () => {
      const { service } = build();
      await service.create('user-1', dto, {});
      await service.create('user-2', { ...dto, label: 'Autre' }, {});
      const mine = await service.list('user-1');
      expect(mine).toHaveLength(1);
      expect(mine[0].label).toBe('Principal');
    });
  });

  describe('verify', () => {
    it('passe en REJECTED quand le droit Withdrawal apparaît après coup', async () => {
      let check = ok;
      const { service, prisma } = build(async () => check);
      const { id } = await service.create('user-1', dto, {});

      check = { ...ok, withdrawalEnabled: true };
      const result = await service.verify('user-1', id, {});

      expect(result.status).toBe(ExchangeStatus.REJECTED);
      expect(result.statusReason).toMatch(/Withdrawal/);
      expect(prisma.auditLogs.at(-1)?.action).toBe('exchange.rejected');
    });

    it('passe en REJECTED quand la clé a été révoquée', async () => {
      let fail = false;
      const { service } = build(async () => {
        if (fail) throw new InvalidCredentialsError();
        return ok;
      });
      const { id } = await service.create('user-1', dto, {});
      fail = true;
      await expect(service.verify('user-1', id, {})).resolves.toMatchObject({
        status: 'REJECTED',
      });
    });

    it('réactive une configuration désactivée si la clé est saine', async () => {
      const { service } = build();
      const { id } = await service.create('user-1', dto, {});
      await service.disable('user-1', id, {});
      await expect(service.verify('user-1', id, {})).resolves.toMatchObject({
        status: 'ACTIVE',
      });
    });

    it('déchiffre la clé stockée pour la re-vérifier', async () => {
      const { service, verifier } = build();
      const { id } = await service.create('user-1', dto, {});
      await service.verify('user-1', id, {});
      expect(verifier.verify).toHaveBeenLastCalledWith(
        { apiKey: dto.apiKey, apiSecret: dto.apiSecret },
        false,
      );
    });

    it('conserve l’état si la plateforme est injoignable', async () => {
      let down = false;
      const { service } = build(async () => {
        if (down) throw new ExchangeUnavailableError();
        return ok;
      });
      const { id } = await service.create('user-1', dto, {});
      down = true;
      await expect(service.verify('user-1', id, {})).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect((await service.list('user-1'))[0].status).toBe('ACTIVE');
    });
  });

  describe('propriété et suppression', () => {
    it('répond 404 pour la configuration d’un autre utilisateur', async () => {
      const { service } = build();
      const { id } = await service.create('user-1', dto, {});
      await expect(service.verify('user-2', id, {})).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.disable('user-2', id, {})).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove('user-2', id, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('désactive', async () => {
      const { service } = build();
      const { id } = await service.create('user-1', dto, {});
      await expect(service.disable('user-1', id, {})).resolves.toMatchObject({
        status: 'DISABLED',
      });
    });

    it('supprime les clés chiffrées quand aucun ordre n’existe', async () => {
      const { service, prisma } = build();
      const { id } = await service.create('user-1', dto, {});
      await service.remove('user-1', id, {});
      expect(prisma.exchangeConfigs).toHaveLength(0);
      expect(prisma.auditLogs.at(-1)?.action).toBe('exchange.deleted');
    });

    it('refuse de supprimer quand des ordres existent', async () => {
      const { service, prisma } = build();
      const { id } = await service.create('user-1', dto, {});
      prisma.tradeLogs.push({ exchangeConfigId: id });
      await expect(service.remove('user-1', id, {})).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.exchangeConfigs).toHaveLength(1);
    });
  });
});
