import { NotFoundException } from '@nestjs/common';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ChannelSender } from './channels/channel-sender.js';
import { NotificationService } from './notification.service.js';

const DAY = new Date('2026-10-23T10:00:00Z'); // 10:00 UTC : jour
const NIGHT = new Date('2026-10-23T23:30:00Z'); // 23:30 UTC : nuit (22:00 → 07:00)

const stubSender = (channel: 'PUSH' | 'TELEGRAM' | 'EMAIL', fail = false) => ({
  channel,
  send: vi.fn(async () =>
    fail
      ? { channel, status: 'FAILED' as const, reason: 'stub_failure' }
      : { channel, status: 'SENT' as const },
  ),
});

async function build(
  timezone = 'UTC',
  senders = [stubSender('PUSH'), stubSender('TELEGRAM'), stubSender('EMAIL')],
) {
  const prisma = new FakePrisma();
  const user = await prisma.user.create({
    data: { email: 'a@example.com', passwordHash: 'x', timezone },
    select: { id: true },
  });
  const settings = prisma.notificationSettingsRows[0];
  return {
    prisma,
    settings,
    userId: user.id as string,
    senders,
    service: new NotificationService(
      prisma as unknown as PrismaService,
      senders as unknown as ChannelSender[],
    ),
  };
}

const msg = { title: 'Titre', body: 'Corps' };

describe('NotificationService', () => {
  describe('envoi', () => {
    it('enregistre puis envoie sur les canaux activés uniquement (push par défaut)', async () => {
      const { service, userId, senders, prisma } = await build();
      const sent = await service.notify(userId, msg, DAY);

      expect(sent).toMatchObject({
        title: 'Titre',
        status: 'DISPATCHED',
        critical: false,
        readAt: null,
        deliveries: [{ channel: 'PUSH', status: 'SENT' }],
      });
      expect(senders[0].send).toHaveBeenCalledTimes(1);
      expect(senders[1].send).not.toHaveBeenCalled();
      expect(prisma.notifications).toHaveLength(1);
    });

    it('envoie sur chaque canal activé, avec le destinataire du compte par défaut', async () => {
      const { service, userId, senders, settings } = await build();
      Object.assign(settings, {
        telegramEnabled: true,
        telegramChatId: '42',
        emailEnabled: true,
      });

      const sent = await service.notify(userId, msg, DAY);

      expect(sent?.deliveries.map((d) => d.channel).sort()).toEqual([
        'EMAIL',
        'PUSH',
        'TELEGRAM',
      ]);
      expect(senders[1].send).toHaveBeenCalledWith(
        { title: 'Titre', body: 'Corps', critical: false },
        { telegramChatId: '42', email: 'a@example.com' },
      );
    });

    it("utilise l'adresse de notification quand elle est définie", async () => {
      const { service, userId, senders, settings } = await build();
      Object.assign(settings, {
        emailEnabled: true,
        notificationEmail: 'alertes@example.com',
      });
      await service.notify(userId, msg, DAY);
      expect(senders[2].send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'alertes@example.com' }),
      );
    });

    it("garde la notification et l'échec d'un canal sans bloquer les autres", async () => {
      const senders = [stubSender('PUSH', true), stubSender('TELEGRAM')];
      const { service, userId, settings } = await build(
        'UTC',
        senders as never,
      );
      Object.assign(settings, { telegramEnabled: true, telegramChatId: '42' });

      const sent = await service.notify(userId, msg, DAY);

      expect(sent?.status).toBe('DISPATCHED');
      expect(sent?.deliveries).toEqual(
        expect.arrayContaining([
          { channel: 'PUSH', status: 'FAILED', reason: 'stub_failure' },
          { channel: 'TELEGRAM', status: 'SENT' },
        ]),
      );
    });

    it('traite un envoyeur qui lève comme un échec, sans perdre la notification', async () => {
      const boom = {
        channel: 'PUSH' as const,
        send: vi.fn(async () => {
          throw new Error('secret-token-xyz');
        }),
      };
      const { service, userId, prisma } = await build('UTC', [boom] as never);

      const sent = await service.notify(userId, msg, DAY);

      expect(sent?.deliveries).toEqual([
        { channel: 'PUSH', status: 'FAILED', reason: 'sender_error' },
      ]);
      expect(JSON.stringify(prisma.notifications)).not.toContain(
        'secret-token-xyz',
      );
    });

    it('signale un canal activé sans envoyeur par un code explicite', async () => {
      const { service, userId } = await build('UTC', []);
      const sent = await service.notify(userId, msg, DAY);
      expect(sent?.deliveries).toEqual([
        {
          channel: 'PUSH',
          status: 'FAILED',
          reason: 'channel_not_implemented',
        },
      ]);
    });

    it('enregistre la notification même sans aucun canal activé', async () => {
      const { service, userId, settings, senders } = await build();
      settings.pushEnabled = false;
      const sent = await service.notify(userId, msg, DAY);
      expect(sent).toMatchObject({ status: 'DISPATCHED', deliveries: [] });
      senders.forEach((s) => expect(s.send).not.toHaveBeenCalled());
    });

    it('tronque le titre à 200 caractères', async () => {
      const { service, userId } = await build();
      const sent = await service.notify(
        userId,
        { ...msg, title: 'x'.repeat(500) },
        DAY,
      );
      expect(sent?.title).toHaveLength(200);
    });

    it('ignore un utilisateur introuvable ou désactivé', async () => {
      const { service, userId, prisma } = await build();
      await expect(service.notify('inconnu', msg, DAY)).resolves.toBeNull();
      prisma.users[0].deletedAt = new Date();
      await expect(service.notify(userId, msg, DAY)).resolves.toBeNull();
      expect(prisma.notifications).toHaveLength(0);
    });
  });

  describe('canal imposé (alerte configurée sur un canal)', () => {
    it("n'envoie que sur ce canal, même s'il n'est pas activé dans les réglages", async () => {
      const { service, userId, senders, settings } = await build();
      Object.assign(settings, { telegramChatId: '42' }); // Telegram non activé globalement

      const sent = await service.notify(
        userId,
        { ...msg, channel: 'TELEGRAM' },
        DAY,
      );

      expect(sent?.deliveries).toEqual([
        { channel: 'TELEGRAM', status: 'SENT' },
      ]);
      expect(senders[1].send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ telegramChatId: '42' }),
      );
      expect(senders[0].send).not.toHaveBeenCalled(); // Push est activé mais non demandé
    });

    it("signale l'échec du canal imposé (conversation manquante) sans basculer sur un autre", async () => {
      const failing = [
        {
          channel: 'TELEGRAM' as const,
          send: vi.fn(async () => ({
            channel: 'TELEGRAM' as const,
            status: 'FAILED' as const,
            reason: 'telegram_no_chat',
          })),
        },
        stubSender('PUSH'),
      ];
      const { service, userId } = await build('UTC', failing as never);
      const sent = await service.notify(
        userId,
        { ...msg, channel: 'TELEGRAM' },
        DAY,
      );
      expect(sent?.deliveries).toEqual([
        { channel: 'TELEGRAM', status: 'FAILED', reason: 'telegram_no_chat' },
      ]);
    });

    it('respecte le Mode Nuit : une alerte non critique sur un canal imposé est mise en attente', async () => {
      const { service, userId, senders } = await build();
      const held = await service.notify(
        userId,
        { ...msg, channel: 'TELEGRAM' },
        NIGHT,
      );
      expect(held?.status).toBe('HELD');
      senders.forEach((s) => expect(s.send).not.toHaveBeenCalled());
    });
  });

  describe('Mode Nuit', () => {
    it('met une notification non critique en attente, sans rien envoyer', async () => {
      const { service, userId, senders, prisma } = await build();
      const held = await service.notify(userId, msg, NIGHT);

      expect(held).toMatchObject({ status: 'HELD', deliveries: [] });
      senders.forEach((s) => expect(s.send).not.toHaveBeenCalled());
      expect(prisma.notifications).toHaveLength(1);
    });

    it('laisse toujours passer une notification critique', async () => {
      const { service, userId, senders } = await build();
      const sent = await service.notify(
        userId,
        { ...msg, critical: true },
        NIGHT,
      );

      expect(sent).toMatchObject({ status: 'DISPATCHED', critical: true });
      expect(senders[0].send).toHaveBeenCalledTimes(1);
    });

    it("envoie immédiatement quand l'envoi est « immediate » (message de test)", async () => {
      const { service, userId } = await build();
      const sent = await service.notify(
        userId,
        { ...msg, immediate: true },
        NIGHT,
      );
      expect(sent).toMatchObject({ status: 'DISPATCHED', critical: false });
    });

    it('ne retient rien quand le Mode Nuit est désactivé', async () => {
      const { service, userId, settings } = await build();
      settings.nightModeEnabled = false;
      expect((await service.notify(userId, msg, NIGHT))?.status).toBe(
        'DISPATCHED',
      );
    });

    it("applique la plage dans le fuseau de l'utilisateur", async () => {
      // 22:30 UTC = 00:30 à Paris (nuit) mais 15:30 à Los Angeles (jour).
      const instant = new Date('2026-10-23T22:30:00Z');
      const paris = await build('Europe/Paris');
      const la = await build('America/Los_Angeles');
      expect(
        (await paris.service.notify(paris.userId, msg, instant))?.status,
      ).toBe('HELD');
      expect((await la.service.notify(la.userId, msg, instant))?.status).toBe(
        'DISPATCHED',
      );
    });

    it('respecte la plage personnalisée', async () => {
      const { service, userId, settings } = await build();
      Object.assign(settings, { nightStartMinute: 780, nightEndMinute: 900 }); // 13:00 → 15:00
      expect(
        (await service.notify(userId, msg, new Date('2026-10-23T14:00:00Z')))
          ?.status,
      ).toBe('HELD');
      expect((await service.notify(userId, msg, NIGHT))?.status).toBe(
        'DISPATCHED',
      );
    });
  });

  describe('déduplication', () => {
    it('renvoie la notification existante pour une même clé, sans renvoyer', async () => {
      const { service, userId, senders, prisma } = await build();
      const first = await service.notify(
        userId,
        { ...msg, dedupeKey: 'daily-loss:2026-10-23' },
        DAY,
      );
      const second = await service.notify(
        userId,
        { ...msg, dedupeKey: 'daily-loss:2026-10-23' },
        DAY,
      );

      expect(second?.id).toBe(first?.id);
      expect(prisma.notifications).toHaveLength(1);
      expect(senders[0].send).toHaveBeenCalledTimes(1);
    });

    it('tolère deux appels simultanés avec la même clé (contrainte unique)', async () => {
      const { service, userId, prisma, senders } = await build();
      const input = { ...msg, dedupeKey: 'k' };
      const [a, b] = await Promise.all([
        service.notify(userId, input, DAY),
        service.notify(userId, input, DAY),
      ]);

      expect(a?.id).toBe(b?.id);
      expect(prisma.notifications).toHaveLength(1);
      expect(senders[0].send).toHaveBeenCalledTimes(1);
    });

    it('distingue les clés et les utilisateurs', async () => {
      const { service, userId, prisma } = await build();
      await service.notify(userId, { ...msg, dedupeKey: 'a' }, DAY);
      await service.notify(userId, { ...msg, dedupeKey: 'b' }, DAY);
      await service.notify(userId, msg, DAY);
      await service.notify(userId, msg, DAY); // sans clé : jamais dédupliqué
      expect(prisma.notifications).toHaveLength(4);
    });
  });

  describe('boîte de réception', () => {
    it('liste les plus récentes d’abord avec le nombre de non lues', async () => {
      const { service, userId } = await build();
      for (const title of ['un', 'deux', 'trois'])
        await service.notify(userId, { title, body: '-' }, DAY);

      const { items, unreadCount } = await service.list(userId, { limit: 30 });
      expect(items.map((n) => n.title)).toEqual(['trois', 'deux', 'un']);
      expect(unreadCount).toBe(3);
    });

    it('limite, pagine par date et filtre les non lues', async () => {
      const { service, userId } = await build();
      for (const title of ['un', 'deux', 'trois'])
        await service.notify(userId, { title, body: '-' }, DAY);

      const first = await service.list(userId, { limit: 2 });
      expect(first.items.map((n) => n.title)).toEqual(['trois', 'deux']);

      const next = await service.list(userId, {
        limit: 2,
        before: first.items[1].createdAt,
      });
      expect(next.items.map((n) => n.title)).toEqual(['un']);

      await service.markRead(userId, first.items[0].id);
      const unread = await service.list(userId, {
        limit: 30,
        unreadOnly: true,
      });
      expect(unread.items.map((n) => n.title)).toEqual(['deux', 'un']);
      expect(unread.unreadCount).toBe(2);
    });

    it('inclut les notifications mises en attente', async () => {
      const { service, userId } = await build();
      await service.notify(userId, msg, NIGHT);
      const { items } = await service.list(userId, { limit: 30 });
      expect(items[0].status).toBe('HELD');
    });

    it('marque lue (idempotent) et répond 404 pour la notification d’un autre', async () => {
      const { service, userId } = await build();
      const created = (await service.notify(userId, msg, DAY))!;

      const read = await service.markRead(userId, created.id);
      expect(read.readAt).toBeInstanceOf(Date);
      const again = await service.markRead(userId, created.id);
      expect(again.readAt).toEqual(read.readAt);

      await expect(service.markRead('autre', created.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('marque tout comme lu pour cet utilisateur seulement', async () => {
      const { service, userId } = await build();
      await service.notify(userId, msg, DAY);
      await service.notify(userId, msg, DAY);

      await expect(service.markAllRead(userId)).resolves.toEqual({
        updated: 2,
      });
      await expect(service.markAllRead(userId)).resolves.toEqual({
        updated: 0,
      });
      expect((await service.list(userId, { limit: 30 })).unreadCount).toBe(0);
    });
  });
});
