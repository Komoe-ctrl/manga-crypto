import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RiskSettingsDto, UpdateRiskSettingsDto } from './dto/risk.dto.js';
import type { DecimalInput } from './risk-rules.js';

const FIELDS = [
  'maxExposurePct',
  'maxDailyLossPct',
  'defaultStopLossPct',
  'defaultTakeProfitPct',
] as const;
type Field = (typeof FIELDS)[number];

const SELECT = {
  maxExposurePct: true,
  maxDailyLossPct: true,
  defaultStopLossPct: true,
  defaultTakeProfitPct: true,
} as const;

/** Réglages de risque d'un utilisateur (SPEC module 2). */
@Injectable()
export class RiskSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string): Promise<RiskSettingsDto> {
    return toDto(await this.find(userId));
  }

  /** Met à jour les champs fournis ; audite l'ancienne et la nouvelle valeur de chacun de ceux qui changent. */
  async update(
    userId: string,
    dto: UpdateRiskSettingsDto,
    ctx: RequestContext,
  ): Promise<RiskSettingsDto> {
    const current = await this.find(userId);
    const changes: Record<string, { from: number; to: number }> = {};
    const data: Partial<Record<Field, number>> = {};

    for (const field of FIELDS) {
      const next = dto[field];
      if (next === undefined || new Prisma.Decimal(current[field]).equals(next))
        continue;
      changes[field] = {
        from: new Prisma.Decimal(current[field]).toNumber(),
        to: next,
      };
      data[field] = next;
    }
    if (Object.keys(changes).length === 0) return toDto(current);

    const updated = await this.prisma.riskSettings.update({
      where: { userId },
      data,
      select: SELECT,
    });
    await this.audit.log({
      userId,
      action: 'risk.settings_updated',
      entityType: 'RiskSettings',
      metadata: { changes },
      ...ctx,
    });
    return toDto(updated);
  }

  private async find(userId: string) {
    const settings = await this.prisma.riskSettings.findUnique({
      where: { userId },
      select: SELECT,
    });
    if (!settings) throw new NotFoundException();
    return settings;
  }
}

function toDto(row: Record<Field, DecimalInput>): RiskSettingsDto {
  return {
    maxExposurePct: new Prisma.Decimal(row.maxExposurePct).toNumber(),
    maxDailyLossPct: new Prisma.Decimal(row.maxDailyLossPct).toNumber(),
    defaultStopLossPct: new Prisma.Decimal(row.defaultStopLossPct).toNumber(),
    defaultTakeProfitPct: new Prisma.Decimal(
      row.defaultTakeProfitPct,
    ).toNumber(),
  };
}
