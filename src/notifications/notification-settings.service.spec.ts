import { UnprocessableEntityException } from '@nestjs/common';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { NotificationSettingsService } from './notification-settings.service.js';

async function build() {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const user = await prisma.user.create({
    data: { email: 'a@example.com', passwordHash: 'x' },
    select: { id: true },
  });
  return {
    prisma,
    userId: user.id as string,
    service: new NotificationSettingsService(
      asPrisma,
      new AuditService(asPrisma),
    ),
  };
}

describe('NotificationSettingsService', () => {
  it('renvoie les valeurs par défaut de la SPEC (Mode Nuit 22:00 → 07:00, rapport 08:00)', async () => {
    const { service, userId } = await build();
    await expect(service.get(userId)).resolves.toEqual({
      nightModeEnabled: true,
      nightStartMinute: 1320,
      nightEndMinute: 420,
      digestEnabled: true,
      digestMinute: 480,
      pushEnabled: true,
      telegramEnabled: false,
      emailEnabled: false,
      telegramChatId: null,
      notificationEmail: null,
    });
  });

  it('modifie les champs fournis et audite seulement leurs noms', async () => {
    const { service, userId, prisma } = await build();
    const updated = await service.update(
      userId,
      {
        nightStartMinute: 1380,
        digestMinute: 450,
        telegramEnabled: true,
        telegramChatId: '123456789',
      },
      {},
    );

    expect(updated).toMatchObject({
      nightStartMinute: 1380,
      digestMinute: 450,
      telegramEnabled: true,
      telegramChatId: '123456789',
    });
    expect(prisma.auditLogs.at(-1)).toMatchObject({
      action: 'notification_settings.updated',
      metadata: {
        fields: [
          'nightStartMinute',
          'digestMinute',
          'telegramEnabled',
          'telegramChatId',
        ],
      },
    });
    expect(JSON.stringify(prisma.auditLogs)).not.toContain('123456789');
  });

  it("n'audite rien quand rien ne change", async () => {
    const { service, userId, prisma } = await build();
    await service.update(userId, { nightStartMinute: 1320 }, {});
    await service.update(userId, {}, {});
    expect(prisma.auditLogs).toHaveLength(0);
  });

  it('efface la conversation Telegram avec null', async () => {
    const { service, userId } = await build();
    await service.update(userId, { telegramChatId: '42' }, {});
    await expect(
      service.update(userId, { telegramChatId: null }, {}),
    ).resolves.toMatchObject({ telegramChatId: null });
  });

  it('refuse une plage de Mode Nuit vide', async () => {
    const { service, userId } = await build();
    await expect(
      service.update(userId, { nightEndMinute: 1320 }, {}),
    ).rejects.toThrow(UnprocessableEntityException);
    await expect(
      service.update(userId, { nightStartMinute: 420 }, {}),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('accepte une plage vide quand le Mode Nuit est désactivé', async () => {
    const { service, userId } = await build();
    await expect(
      service.update(
        userId,
        { nightModeEnabled: false, nightStartMinute: 600, nightEndMinute: 600 },
        {},
      ),
    ).resolves.toMatchObject({ nightModeEnabled: false });
  });

  it('refuse Telegram sans conversation, et refuse de la retirer pendant qu’il est actif', async () => {
    const { service, userId } = await build();
    await expect(
      service.update(userId, { telegramEnabled: true }, {}),
    ).rejects.toThrow(UnprocessableEntityException);

    await service.update(
      userId,
      { telegramEnabled: true, telegramChatId: '42' },
      {},
    );
    await expect(
      service.update(userId, { telegramChatId: null }, {}),
    ).rejects.toThrow(UnprocessableEntityException);
  });
});
