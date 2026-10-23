import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuditService } from '../audit/audit.service.js';
import { EncryptionService } from '../crypto/encryption.service.js';
import { Exchange, ExchangeStatus } from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ExchangesService } from './exchanges.service.js';
import type {
  ExchangeVerifier,
  PermissionCheck,
} from './verification/exchange-verifier.js';
import { VerifierRegistry } from './verification/verifier.registry.js';

const ok: PermissionCheck = {
  permissions: ['read', 'trade'],
  withdrawalEnabled: false,
  verified: true,
};
const dto = {
  exchange: Exchange.BINANCE,
  label: 'Principal',
  apiKey: 'public-key-a1b2',
  apiSecret: 'super-secret-value',
};

function build() {
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
    verify: vi.fn(async () => ok),
  } satisfies ExchangeVerifier;
  const service = new ExchangesService(
    asPrisma,
    encryption,
    new AuditService(asPrisma),
    new VerifierRegistry(verifier as never),
  );
  return { prisma, service, verifier };
}

describe('ExchangesService.getLiveCredentials', () => {
  it('déchiffre les clés de la configuration éligible', async () => {
    const { service } = build();
    const { id } = await service.create('u1', dto, {});

    await expect(service.getLiveCredentials('u1')).resolves.toEqual({
      configId: id,
      exchange: 'BINANCE',
      apiKey: dto.apiKey,
      apiSecret: dto.apiSecret,
    });
  });

  it('renvoie null sans configuration', async () => {
    const { service } = build();
    await expect(service.getLiveCredentials('u1')).resolves.toBeNull();
  });

  it.each([
    ['testnet (sandbox)', { sandbox: true }],
    ['désactivée', { status: ExchangeStatus.DISABLED }],
    ['rejetée', { status: ExchangeStatus.REJECTED }],
    ['non vérifiée', { verifiedAt: null }],
  ])('n’est jamais éligible : %s', async (_name, change) => {
    const { service, prisma } = build();
    await service.create('u1', dto, {});
    Object.assign(prisma.exchangeConfigs[0], change);
    await expect(service.getLiveCredentials('u1')).resolves.toBeNull();
  });

  it('suit l’état courant : une configuration désactivée après coup n’est plus éligible', async () => {
    const { service } = build();
    const { id } = await service.create('u1', dto, {});
    expect(await service.getLiveCredentials('u1')).not.toBeNull();
    await service.disable('u1', id, {});
    expect(await service.getLiveCredentials('u1')).toBeNull();
  });

  it('ne renvoie jamais les clés d’un autre utilisateur', async () => {
    const { service } = build();
    await service.create('u1', dto, {});
    await expect(service.getLiveCredentials('u2')).resolves.toBeNull();
  });

  it('refuse de déchiffrer un chiffré recopié sur une autre ligne (AAD)', async () => {
    const { service, prisma } = build();
    await service.create('u1', dto, {});
    await service.create(
      'u1',
      { ...dto, label: 'Second', apiSecret: 'another-secret-1' },
      {},
    );
    // On recopie le secret chiffré de la seconde ligne sur la première.
    prisma.exchangeConfigs[0].apiSecretCipher =
      prisma.exchangeConfigs[1].apiSecretCipher;
    prisma.exchangeConfigs[0].apiSecretIv =
      prisma.exchangeConfigs[1].apiSecretIv;
    prisma.exchangeConfigs[0].apiSecretTag =
      prisma.exchangeConfigs[1].apiSecretTag;

    await expect(service.getLiveCredentials('u1')).rejects.toThrow(
      'Déchiffrement impossible',
    );
  });
});
