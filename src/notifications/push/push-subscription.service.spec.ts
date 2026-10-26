import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { FakePrisma } from '../../../test/support/fake-prisma.js';
import {
  chromeSubscription,
  pushKeys,
} from '../../../test/support/push-keys.js';
import { AuditService } from '../../audit/audit.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { PushSubscriptionService } from './push-subscription.service.js';

async function build(env: Record<string, string> = {}) {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const user = await prisma.user.create({
    data: { email: 'a@example.com', passwordHash: 'x' },
    select: { id: true },
  });
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return {
    prisma,
    userId: user.id as string,
    service: new PushSubscriptionService(
      asPrisma,
      new AuditService(asPrisma),
      config,
    ),
  };
}

const VAPID = {
  VAPID_PUBLIC_KEY: 'BPublicKeyDeTest',
  VAPID_PRIVATE_KEY: 'secret',
  VAPID_SUBJECT: 'mailto:admin@example.com',
};

describe('PushSubscriptionService', () => {
  describe('status', () => {
    it('non configuré : pas de clé publique, aucun appareil', async () => {
      const { service, userId } = await build();
      await expect(service.status(userId)).resolves.toEqual({
        configured: false,
        publicKey: null,
        subscriptions: 0,
      });
    });

    it('configuré : renvoie la clé publique, jamais la clé privée', async () => {
      const { service, userId } = await build(VAPID);
      const status = await service.status(userId);
      expect(status).toEqual({
        configured: true,
        publicKey: 'BPublicKeyDeTest',
        subscriptions: 0,
      });
      expect(JSON.stringify(status)).not.toContain('secret');
    });

    it('utilisateur sans réglages : 404', async () => {
      const { service } = await build();
      await expect(service.status('inconnu')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('add', () => {
    it('enregistre un appareil et compte les appareils', async () => {
      const { service, userId } = await build();
      const status = await service.add(userId, chromeSubscription(), {});
      expect(status.subscriptions).toBe(1);
    });

    it('remplace l’abonnement de même adresse au lieu de le dupliquer', async () => {
      const { service, userId } = await build();
      const device = chromeSubscription();
      await service.add(userId, device, {});
      const status = await service.add(
        userId,
        { ...device, ...pushKeys() },
        {},
      );
      expect(status.subscriptions).toBe(1);
    });

    it('au-delà de 5 appareils, écarte le plus ancien', async () => {
      const { service, userId, prisma } = await build();
      const devices = Array.from({ length: 6 }, () => chromeSubscription());
      for (const device of devices) await service.add(userId, device, {});

      const stored = prisma.notificationSettingsRows[0].pushSubscription as {
        endpoint: string;
      }[];
      expect(stored.map((s) => s.endpoint)).toEqual(
        devices.slice(1).map((d) => d.endpoint),
      );
    });

    it.each([
      'http://localhost/push',
      'https://127.0.0.1/push',
      'https://169.254.169.254/latest/meta-data',
      'https://evil.example/push',
      'https://fcm.googleapis.com@evil.example/push',
    ])('refuse l’adresse %s (422) sans rien enregistrer', async (endpoint) => {
      const { service, userId, prisma } = await build();
      await expect(
        service.add(userId, { ...chromeSubscription(), endpoint }, {}),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(
        prisma.notificationSettingsRows[0].pushSubscription ?? null,
      ).toBeNull();
    });

    it('refuse des clés qui ne sont pas celles d’un navigateur (422)', async () => {
      const { service, userId } = await build();
      await expect(
        service.add(
          userId,
          { ...chromeSubscription(), p256dh: 'AAAA', auth: 'BBBB' },
          {},
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('n’audite que le nombre d’appareils, jamais l’adresse ni les clés', async () => {
      const { service, userId, prisma } = await build();
      const device = chromeSubscription();
      await service.add(userId, device, { ipAddress: '1.2.3.4' });

      const logged = JSON.stringify(prisma.auditLogs);
      expect(logged).toContain('push_subscription.added');
      expect(logged).not.toContain(device.endpoint);
      expect(logged).not.toContain(device.p256dh);
      expect(logged).not.toContain(device.auth);
    });
  });

  describe('remove', () => {
    it('retire un appareil', async () => {
      const { service, userId } = await build();
      const [a, b] = [chromeSubscription(), chromeSubscription()];
      await service.add(userId, a, {});
      await service.add(userId, b, {});

      const status = await service.remove(userId, a.endpoint, {});

      expect(status.subscriptions).toBe(1);
    });

    it('est idempotent : retirer un appareil inconnu ne change rien et n’audite rien', async () => {
      const { service, userId, prisma } = await build();
      await service.add(userId, chromeSubscription(), {});
      const before = prisma.auditLogs.length;

      const status = await service.remove(
        userId,
        'https://fcm.googleapis.com/inconnu',
        {},
      );

      expect(status.subscriptions).toBe(1);
      expect(prisma.auditLogs).toHaveLength(before);
    });

    it('retirer le dernier appareil vide la colonne', async () => {
      const { service, userId } = await build();
      const device = chromeSubscription();
      await service.add(userId, device, {});
      await expect(
        service.remove(userId, device.endpoint, {}),
      ).resolves.toMatchObject({ subscriptions: 0 });
    });
  });

  describe('removeExpired', () => {
    it('retire l’appareil révoqué et l’audite sans son adresse', async () => {
      const { service, userId, prisma } = await build();
      const [alive, dead] = [chromeSubscription(), chromeSubscription()];
      await service.add(userId, alive, {});
      await service.add(userId, dead, {});

      await service.removeExpired(userId, dead.endpoint);

      await expect(service.status(userId)).resolves.toMatchObject({
        subscriptions: 1,
      });
      const logged = JSON.stringify(prisma.auditLogs);
      expect(logged).toContain('push_subscription.expired');
      expect(logged).not.toContain(dead.endpoint);
    });

    it('ne fait rien si l’appareil n’est plus enregistré', async () => {
      const { service, userId, prisma } = await build();
      const before = prisma.auditLogs.length;
      await service.removeExpired(userId, 'https://fcm.googleapis.com/inconnu');
      expect(prisma.auditLogs).toHaveLength(before);
    });
  });
});
