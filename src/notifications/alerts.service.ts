import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  AlertCondition,
  type NotificationChannel,
} from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AlertDto,
  CreateAlertDto,
  UpdateAlertDto,
} from './dto/alerts.dto.js';

/** Plafond par utilisateur : borne le travail du futur moteur d'évaluation. */
export const MAX_ALERTS_PER_USER = 50;
/** Fenêtre glissante : de 5 minutes à 7 jours. */
const MIN_WINDOW_MINUTES = 5;
const MAX_WINDOW_MINUTES = 10_080;

const SELECT = {
  id: true,
  assetSymbol: true,
  condition: true,
  threshold: true,
  windowMinutes: true,
  channel: true,
  isActive: true,
  isCritical: true,
  isTriggered: true,
  lastTriggeredAt: true,
  createdAt: true,
} as const;

interface AlertShape {
  assetSymbol: string | null;
  condition: AlertCondition;
  threshold: Prisma.Decimal;
  windowMinutes: number | null;
}

/**
 * Cohérence d'une alerte, selon sa condition (maquette : « baisse de X % en 1 h », « franchit un prix »…).
 * @returns le motif du refus, ou `null` si l'alerte est valide.
 */
export function alertProblem(alert: AlertShape): string | null {
  const { condition, assetSymbol, threshold, windowMinutes } = alert;
  const hasWindow = windowMinutes !== null;

  switch (condition) {
    case AlertCondition.PRICE_CROSS_ABOVE:
    case AlertCondition.PRICE_CROSS_BELOW:
      if (!assetSymbol) return 'assetSymbol est requis pour une alerte de prix';
      if (hasWindow)
        return "windowMinutes n'a pas de sens pour un franchissement de prix";
      return null;

    case AlertCondition.PRICE_DROP_PCT:
    case AlertCondition.PRICE_RISE_PCT:
    case AlertCondition.PORTFOLIO_DROP_PCT: {
      const portfolio = condition === AlertCondition.PORTFOLIO_DROP_PCT;
      if (portfolio && assetSymbol)
        return "assetSymbol n'a pas de sens pour une alerte portant sur le portefeuille";
      if (!portfolio && !assetSymbol)
        return 'assetSymbol est requis pour une alerte de variation';
      if (!hasWindow)
        return 'windowMinutes est requis pour une alerte de variation';
      if (
        windowMinutes < MIN_WINDOW_MINUTES ||
        windowMinutes > MAX_WINDOW_MINUTES
      ) {
        return `windowMinutes doit être compris entre ${MIN_WINDOW_MINUTES} et ${MAX_WINDOW_MINUTES}`;
      }
      // Une baisse ne peut pas dépasser 100 % ; une hausse n'est pas bornée mais reste raisonnable.
      const max = condition === AlertCondition.PRICE_RISE_PCT ? 1000 : 100;
      if (threshold.gt(max)) return `threshold ne peut pas dépasser ${max} %`;
      return null;
    }
  }
}

/** Alertes personnalisées (condition, seuil, canal, critique). L'évaluation sur les prix est faite par le moteur d'alertes. */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    userId: string,
    dto: CreateAlertDto,
    ctx: RequestContext,
  ): Promise<AlertDto> {
    const shape: AlertShape = {
      assetSymbol: dto.assetSymbol ?? null,
      condition: dto.condition,
      threshold: new Prisma.Decimal(dto.threshold),
      windowMinutes: dto.windowMinutes ?? null,
    };
    refuseIfInvalid(shape);

    if (
      (await this.prisma.alertConfig.count({ where: { userId } })) >=
      MAX_ALERTS_PER_USER
    ) {
      throw new UnprocessableEntityException(
        `Limite de ${MAX_ALERTS_PER_USER} alertes atteinte`,
      );
    }

    const created = await this.prisma.alertConfig.create({
      data: {
        userId,
        ...shape,
        channel: dto.channel as NotificationChannel,
        isActive: dto.isActive ?? true,
        isCritical: dto.isCritical ?? false,
      },
      select: SELECT,
    });
    await this.audit.log({
      userId,
      action: 'alert.created',
      entityType: 'AlertConfig',
      entityId: created.id,
      metadata: { condition: dto.condition, assetSymbol: shape.assetSymbol },
      ...ctx,
    });
    return toDto(created);
  }

  async list(userId: string): Promise<AlertDto[]> {
    const rows = await this.prisma.alertConfig.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: SELECT,
    });
    return rows.map(toDto);
  }

  /** La condition et le symbole ne changent pas (créer une autre alerte) ; le reste se modifie, cohérence revérifiée. */
  async update(
    userId: string,
    id: string,
    dto: UpdateAlertDto,
    ctx: RequestContext,
  ): Promise<AlertDto> {
    const current = await this.findOwned(userId, id);
    const shape: AlertShape = {
      assetSymbol: current.assetSymbol,
      condition: current.condition,
      threshold:
        dto.threshold !== undefined
          ? new Prisma.Decimal(dto.threshold)
          : new Prisma.Decimal(current.threshold),
      windowMinutes:
        dto.windowMinutes !== undefined
          ? dto.windowMinutes
          : current.windowMinutes,
    };
    refuseIfInvalid(shape);

    const updated = await this.prisma.alertConfig.update({
      where: { id },
      data: {
        threshold: shape.threshold,
        windowMinutes: shape.windowMinutes,
        // Changer le seuil, la fenêtre ou l'activation ré-arme l'alerte : l'ancien état « déclenchée » ne vaut plus.
        ...(rearms(dto) && { isTriggered: false }),
        ...(dto.channel !== undefined && {
          channel: dto.channel as NotificationChannel,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.isCritical !== undefined && { isCritical: dto.isCritical }),
      },
      select: SELECT,
    });
    await this.audit.log({
      userId,
      action: 'alert.updated',
      entityType: 'AlertConfig',
      entityId: id,
      metadata: {
        fields: Object.keys(dto).filter(
          (k) => dto[k as keyof UpdateAlertDto] !== undefined,
        ),
      },
      ...ctx,
    });
    return toDto(updated);
  }

  async remove(userId: string, id: string, ctx: RequestContext): Promise<void> {
    await this.findOwned(userId, id);
    await this.prisma.alertConfig.delete({ where: { id } });
    await this.audit.log({
      userId,
      action: 'alert.deleted',
      entityType: 'AlertConfig',
      entityId: id,
      ...ctx,
    });
  }

  private async findOwned(userId: string, id: string) {
    const row = await this.prisma.alertConfig.findFirst({
      where: { id, userId },
      select: SELECT,
    });
    if (!row) throw new NotFoundException();
    return row;
  }
}

const rearms = (dto: UpdateAlertDto): boolean =>
  dto.threshold !== undefined ||
  dto.windowMinutes !== undefined ||
  dto.isActive !== undefined;

function refuseIfInvalid(shape: AlertShape): void {
  const problem = alertProblem(shape);
  if (problem) throw new UnprocessableEntityException(problem);
}

const toDto = (row: {
  id: string;
  assetSymbol: string | null;
  condition: AlertCondition;
  threshold: Prisma.Decimal;
  windowMinutes: number | null;
  channel: NotificationChannel;
  isActive: boolean;
  isCritical: boolean;
  isTriggered: boolean;
  lastTriggeredAt: Date | null;
  createdAt: Date;
}): AlertDto => ({
  ...row,
  threshold: new Prisma.Decimal(row.threshold).toFixed(),
});
