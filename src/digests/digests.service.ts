import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { DigestPeriod } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { DigestDto } from './dto/digests.dto.js';

const SELECT = {
  id: true,
  period: true,
  periodStart: true,
  periodEnd: true,
  summary: true,
  points: true,
  portfolioDeltaPct: true,
  queuedAlertsCount: true,
  readAt: true,
  generatedAt: true,
} as const;

/** Consultation des rapports du matin générés par `DigestGenerator`. */
@Injectable()
export class DigestsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Les plus récents d'abord. `period` filtre « Ce matin / Hier » (TODAY) ou « 7 jours » (WEEK). */
  async list(
    userId: string,
    options: { limit: number; before?: Date; period?: DigestPeriod },
  ): Promise<{ items: DigestDto[]; unreadCount: number }> {
    const [rows, unreadCount] = await Promise.all([
      this.prisma.digestReport.findMany({
        where: {
          userId,
          ...(options.period && { period: options.period }),
          ...(options.before && { generatedAt: { lt: options.before } }),
        },
        orderBy: { generatedAt: 'desc' },
        take: options.limit,
        select: SELECT,
      }),
      this.prisma.digestReport.count({ where: { userId, readAt: null } }),
    ]);
    return { items: rows.map(toDto), unreadCount };
  }

  async get(userId: string, id: string): Promise<DigestDto> {
    return toDto(await this.findOwned(userId, id));
  }

  /** Marque un rapport comme lu (idempotent). 404 s'il n'appartient pas à l'utilisateur. */
  async markRead(userId: string, id: string): Promise<DigestDto> {
    const row = await this.findOwned(userId, id);
    if (row.readAt) return toDto(row);
    await this.prisma.digestReport.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return toDto(await this.findOwned(userId, id));
  }

  private async findOwned(userId: string, id: string) {
    const row = await this.prisma.digestReport.findFirst({
      where: { id, userId },
      select: SELECT,
    });
    if (!row) throw new NotFoundException();
    return row;
  }
}

const toDto = (row: {
  id: string;
  period: DigestPeriod;
  periodStart: Date;
  periodEnd: Date;
  summary: string;
  points: string[];
  portfolioDeltaPct: Prisma.Decimal | null;
  queuedAlertsCount: number;
  readAt: Date | null;
  generatedAt: Date;
}): DigestDto => ({
  ...row,
  portfolioDeltaPct:
    row.portfolioDeltaPct === null
      ? null
      : new Prisma.Decimal(row.portfolioDeltaPct).toFixed(),
});
