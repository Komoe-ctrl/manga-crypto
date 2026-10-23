import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AlertCondition,
  NotificationChannel,
} from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AlertsService } from './alerts.service.js';

async function build() {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const service = new AlertsService(asPrisma, new AuditService(asPrisma));
  const { id } = await service.create(
    'u1',
    {
      assetSymbol: 'BTC',
      condition: AlertCondition.PRICE_DROP_PCT,
      threshold: '5',
      windowMinutes: 60,
      channel: NotificationChannel.PUSH,
    },
    {},
  );
  // L'alerte a été déclenchée par le moteur.
  prisma.alertConfigs[0].isTriggered = true;
  return { prisma, service, id };
}

describe('Ré-armement d’une alerte modifiée', () => {
  it('expose l’état « déclenchée » (armée = faux)', async () => {
    const { service } = await build();
    expect((await service.list('u1'))[0].isTriggered).toBe(true);
  });

  it.each([
    [{ threshold: '7' }],
    [{ windowMinutes: 120 }],
    [{ isActive: false }],
    [{ isActive: true }],
  ])('%j ré-arme l’alerte', async (change) => {
    const { service, id, prisma } = await build();
    const updated = await service.update('u1', id, change, {});
    expect(updated.isTriggered).toBe(false);
    expect(prisma.alertConfigs[0].isTriggered).toBe(false);
  });

  it.each([
    [{ channel: NotificationChannel.TELEGRAM }],
    [{ isCritical: true }],
  ])(
    '%j ne change pas l’état (la condition n’est pas modifiée)',
    async (change) => {
      const { service, id } = await build();
      expect((await service.update('u1', id, change, {})).isTriggered).toBe(
        true,
      );
    },
  );
});
