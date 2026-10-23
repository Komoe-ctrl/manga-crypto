import { NotFoundException } from '@nestjs/common';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DigestsService } from './digests.service.js';

function build() {
  const prisma = new FakePrisma();
  const service = new DigestsService(prisma as unknown as PrismaService);
  const report = (userId: string, over: Record<string, unknown> = {}) =>
    prisma.digestReport.create({
      data: {
        userId,
        period: 'TODAY',
        periodStart: new Date(
          Date.UTC(2026, 9, 1 + prisma.digestReports.length),
        ),
        periodEnd: new Date(),
        summary: 'Nuit calme.',
        points: ['Valeur du portefeuille : 110 $'],
        portfolioDeltaPct: 1.2,
        queuedAlertsCount: 0,
        ...over,
      },
    });
  return { prisma, service, report };
}

describe('DigestsService', () => {
  it('liste les plus récents d’abord, avec la variation en chaîne décimale et les non lus', async () => {
    const { service, report } = build();
    await report('u1', { summary: 'un' });
    await report('u1', { summary: 'deux', portfolioDeltaPct: null });

    const { items, unreadCount } = await service.list('u1', { limit: 30 });

    expect(items.map((d) => d.summary)).toEqual(['deux', 'un']);
    expect(items.map((d) => d.portfolioDeltaPct)).toEqual([null, '1.2']);
    expect(unreadCount).toBe(2);
  });

  it('filtre par période et limite', async () => {
    const { service, report } = build();
    await report('u1', { period: 'TODAY' });
    await report('u1', { period: 'WEEK' });
    await report('u1', { period: 'TODAY' });

    expect(
      (await service.list('u1', { limit: 30, period: 'WEEK' })).items,
    ).toHaveLength(1);
    expect((await service.list('u1', { limit: 1 })).items).toHaveLength(1);
  });

  it('pagine par date de génération', async () => {
    const { service, report } = build();
    for (const summary of ['un', 'deux', 'trois'])
      await report('u1', { summary });

    const first = await service.list('u1', { limit: 2 });
    const next = await service.list('u1', {
      limit: 2,
      before: first.items[1].generatedAt,
    });
    expect(first.items.map((d) => d.summary)).toEqual(['trois', 'deux']);
    expect(next.items.map((d) => d.summary)).toEqual(['un']);
  });

  it('ne liste que les rapports de l’utilisateur', async () => {
    const { service, report } = build();
    await report('u1');
    await report('u2');
    expect((await service.list('u1', { limit: 30 })).items).toHaveLength(1);
    expect((await service.list('u3', { limit: 30 })).unreadCount).toBe(0);
  });

  it('lit un rapport, 404 s’il n’appartient pas à l’utilisateur', async () => {
    const { service, report } = build();
    const { id } = await report('u1');
    await expect(service.get('u1', id)).resolves.toMatchObject({
      id,
      summary: 'Nuit calme.',
    });
    await expect(service.get('u2', id)).rejects.toThrow(NotFoundException);
    await expect(service.get('u1', 'inconnu')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('marque lu (idempotent) et décompte les non lus', async () => {
    const { service, report } = build();
    const { id } = await report('u1');
    await report('u1');

    const read = await service.markRead('u1', id);
    expect(read.readAt).toBeInstanceOf(Date);
    await expect(service.markRead('u1', id)).resolves.toMatchObject({
      readAt: read.readAt,
    });
    expect((await service.list('u1', { limit: 30 })).unreadCount).toBe(1);
  });

  it('ne marque pas lu le rapport d’un autre', async () => {
    const { service, report, prisma } = build();
    const { id } = await report('u1');
    await expect(service.markRead('u2', id)).rejects.toThrow(NotFoundException);
    expect(prisma.digestReports[0].readAt).toBeNull();
  });
});
