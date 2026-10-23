import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuditService } from '../audit/audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  AlertCondition,
  NotificationChannel,
} from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  AlertsService,
  MAX_ALERTS_PER_USER,
  alertProblem,
} from './alerts.service.js';
import type { CreateAlertDto } from './dto/alerts.dto.js';

const drop: CreateAlertDto = {
  assetSymbol: 'BTC',
  condition: AlertCondition.PRICE_DROP_PCT,
  threshold: '5',
  windowMinutes: 60,
  channel: NotificationChannel.PUSH,
};

function build() {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  return {
    prisma,
    service: new AlertsService(asPrisma, new AuditService(asPrisma)),
  };
}

describe('alertProblem (cohérence selon la condition)', () => {
  const shape = (over: Partial<Parameters<typeof alertProblem>[0]>) => ({
    assetSymbol: 'BTC',
    condition: AlertCondition.PRICE_DROP_PCT,
    threshold: new Prisma.Decimal(5),
    windowMinutes: 60 as number | null,
    ...over,
  });

  it('accepte les alertes de la maquette', () => {
    expect(alertProblem(shape({}))).toBeNull(); // BTC −5 % en 1 h
    expect(
      alertProblem(
        shape({
          condition: AlertCondition.PRICE_CROSS_ABOVE,
          threshold: new Prisma.Decimal(3500),
          assetSymbol: 'ETH',
          windowMinutes: null,
        }),
      ),
    ).toBeNull();
    expect(
      alertProblem(
        shape({
          condition: AlertCondition.PRICE_RISE_PCT,
          assetSymbol: 'SOL',
          threshold: new Prisma.Decimal(8),
          windowMinutes: 1440,
        }),
      ),
    ).toBeNull();
    expect(
      alertProblem(
        shape({
          condition: AlertCondition.PORTFOLIO_DROP_PCT,
          assetSymbol: null,
          threshold: new Prisma.Decimal(10),
          windowMinutes: 10080,
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [
      'prix sans symbole',
      {
        condition: AlertCondition.PRICE_CROSS_BELOW,
        assetSymbol: null,
        windowMinutes: null,
      },
    ],
    [
      'franchissement avec fenêtre',
      { condition: AlertCondition.PRICE_CROSS_ABOVE, windowMinutes: 60 },
    ],
    ['variation sans symbole', { assetSymbol: null }],
    ['variation sans fenêtre', { windowMinutes: null }],
    ['fenêtre trop courte', { windowMinutes: 4 }],
    ['fenêtre trop longue', { windowMinutes: 10_081 }],
    [
      'portefeuille avec symbole',
      { condition: AlertCondition.PORTFOLIO_DROP_PCT, assetSymbol: 'BTC' },
    ],
    ['baisse de plus de 100 %', { threshold: new Prisma.Decimal(100.01) }],
    [
      'hausse de plus de 1000 %',
      {
        condition: AlertCondition.PRICE_RISE_PCT,
        threshold: new Prisma.Decimal(1000.01),
      },
    ],
  ])('refuse : %s', (_name, over) => {
    expect(alertProblem(shape(over as never))).toEqual(expect.any(String));
  });
});

describe('AlertsService', () => {
  it('crée une alerte (active, non critique par défaut) et audite', async () => {
    const { service, prisma } = build();
    const created = await service.create('u1', drop, {});

    expect(created).toMatchObject({
      assetSymbol: 'BTC',
      condition: 'PRICE_DROP_PCT',
      threshold: '5',
      windowMinutes: 60,
      channel: 'PUSH',
      isActive: true,
      isCritical: false,
      lastTriggeredAt: null,
    });
    expect(prisma.auditLogs.at(-1)).toMatchObject({
      action: 'alert.created',
      entityId: created.id,
    });
  });

  it('refuse une alerte incohérente avec un 422, sans rien stocker', async () => {
    const { service, prisma } = build();
    await expect(
      service.create('u1', { ...drop, windowMinutes: undefined }, {}),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(prisma.alertConfigs).toHaveLength(0);
  });

  it(`refuse au-delà de ${MAX_ALERTS_PER_USER} alertes par utilisateur`, async () => {
    const { service, prisma } = build();
    for (let i = 0; i < MAX_ALERTS_PER_USER; i++)
      await service.create('u1', drop, {});
    await expect(service.create('u1', drop, {})).rejects.toThrow(
      UnprocessableEntityException,
    );
    // Un autre utilisateur n'est pas concerné.
    await expect(service.create('u2', drop, {})).resolves.toBeDefined();
    expect(prisma.alertConfigs).toHaveLength(MAX_ALERTS_PER_USER + 1);
  });

  it('liste uniquement les alertes de l’utilisateur', async () => {
    const { service } = build();
    await service.create('u1', drop, {});
    await service.create('u2', { ...drop, assetSymbol: 'ETH' }, {});
    expect((await service.list('u1')).map((a) => a.assetSymbol)).toEqual([
      'BTC',
    ]);
  });

  describe('modification', () => {
    it('modifie seuil, fenêtre, canal, activation et criticité', async () => {
      const { service, prisma } = build();
      const { id } = await service.create('u1', drop, {});

      const updated = await service.update(
        'u1',
        id,
        {
          threshold: '7.5',
          windowMinutes: 1440,
          channel: NotificationChannel.TELEGRAM,
          isActive: false,
          isCritical: true,
        },
        {},
      );

      expect(updated).toMatchObject({
        threshold: '7.5',
        windowMinutes: 1440,
        channel: 'TELEGRAM',
        isActive: false,
        isCritical: true,
      });
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'alert.updated',
        metadata: {
          fields: [
            'threshold',
            'windowMinutes',
            'channel',
            'isActive',
            'isCritical',
          ],
        },
      });
    });

    it('revérifie la cohérence : une fenêtre sur un franchissement est refusée', async () => {
      const { service } = build();
      const { id } = await service.create(
        'u1',
        {
          ...drop,
          condition: AlertCondition.PRICE_CROSS_ABOVE,
          threshold: '3500',
          windowMinutes: undefined,
        },
        {},
      );
      await expect(
        service.update('u1', id, { windowMinutes: 60 }, {}),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('revérifie le plafond d’une baisse (100 %)', async () => {
      const { service } = build();
      const { id } = await service.create('u1', drop, {});
      await expect(
        service.update('u1', id, { threshold: '150' }, {}),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it("répond 404 pour l'alerte d'un autre utilisateur", async () => {
      const { service } = build();
      const { id } = await service.create('u1', drop, {});
      await expect(
        service.update('u2', id, { isActive: false }, {}),
      ).rejects.toThrow(NotFoundException);
      await expect(service.remove('u2', id, {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('supprime et audite', async () => {
    const { service, prisma } = build();
    const { id } = await service.create('u1', drop, {});
    await service.remove('u1', id, {});
    expect(prisma.alertConfigs).toHaveLength(0);
    expect(prisma.auditLogs.at(-1)?.action).toBe('alert.deleted');
  });
});
