import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { PasswordService } from '../auth/password.service.js';
import { ExchangeStatus, TradingMode } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  BlockedReason,
  SwitchToLiveDto,
  TradingStatusDto,
} from './dto/risk.dto.js';

const STATUS_SELECT = {
  tradingMode: true,
  tradingModeChangedAt: true,
  killSwitchActive: true,
  killSwitchAt: true,
  botPausedUntil: true,
} as const;

/**
 * Contrôle du robot : kill switch, mode PAPER/LIVE et état « peut-on passer un ordre ? ».
 * Le futur module d'ordres doit appeler `status()` avant chaque ordre et s'arrêter si `canTrade` est faux.
 */
@Injectable()
export class TradingControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async status(userId: string): Promise<TradingStatusDto> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: STATUS_SELECT,
    });
    if (!user) throw new NotFoundException();

    const blockedReason: BlockedReason | null = user.killSwitchActive
      ? 'KILL_SWITCH'
      : user.botPausedUntil && user.botPausedUntil > new Date()
        ? 'PAUSED_DAILY_LOSS'
        : null;
    return { ...user, canTrade: blockedReason === null, blockedReason };
  }

  /** Arrête le robot immédiatement (aucun ordre n'est plus passé). Idempotent. */
  async activateKillSwitch(
    userId: string,
    ctx: RequestContext,
  ): Promise<TradingStatusDto> {
    if ((await this.status(userId)).killSwitchActive)
      return this.status(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { killSwitchActive: true, killSwitchAt: new Date() },
    });
    await this.audit.log({
      userId,
      action: 'kill_switch.activated',
      entityType: 'User',
      entityId: userId,
      ...ctx,
    });
    return this.status(userId);
  }

  async deactivateKillSwitch(
    userId: string,
    ctx: RequestContext,
  ): Promise<TradingStatusDto> {
    if (!(await this.status(userId)).killSwitchActive)
      return this.status(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { killSwitchActive: false },
    });
    await this.audit.log({
      userId,
      action: 'kill_switch.deactivated',
      entityType: 'User',
      entityId: userId,
      ...ctx,
    });
    return this.status(userId);
  }

  /**
   * Passage en LIVE : ré-authentification par mot de passe, kill switch désactivé et au moins une configuration
   * d'échange active, vérifiée et hors testnet. Chaque refus est audité.
   */
  async switchToLive(
    userId: string,
    dto: SwitchToLiveDto,
    ctx: RequestContext,
  ): Promise<TradingStatusDto> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { ...STATUS_SELECT, passwordHash: true },
    });
    if (!user) throw new NotFoundException();

    const base = { userId, entityType: 'User', entityId: userId, ...ctx };
    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      await this.audit.log({
        ...base,
        action: 'mode.live_denied',
        metadata: { reason: 'bad_password' },
      });
      // 403 et non 401 : le front ne doit pas y voir une session expirée.
      throw new ForbiddenException('Mot de passe incorrect');
    }
    if (user.tradingMode === TradingMode.LIVE) return this.status(userId);

    if (user.killSwitchActive) {
      await this.audit.log({
        ...base,
        action: 'mode.live_denied',
        metadata: { reason: 'kill_switch' },
      });
      throw new UnprocessableEntityException(
        'Désactivez le kill switch avant de passer en LIVE',
      );
    }
    const exchange = await this.prisma.exchangeConfig.findFirst({
      where: {
        userId,
        status: ExchangeStatus.ACTIVE,
        sandbox: false,
        verifiedAt: { not: null },
      },
      select: { id: true },
    });
    if (!exchange) {
      await this.audit.log({
        ...base,
        action: 'mode.live_denied',
        metadata: { reason: 'no_verified_exchange' },
      });
      throw new UnprocessableEntityException(
        "Le mode LIVE exige une configuration d'échange active, vérifiée et hors testnet",
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { tradingMode: TradingMode.LIVE, tradingModeChangedAt: new Date() },
    });
    await this.audit.log({
      ...base,
      action: 'mode.live_enabled',
      metadata: { exchangeConfigId: exchange.id },
    });
    return this.status(userId);
  }

  /** Retour en simulation : toujours immédiat, sans condition. */
  async switchToPaper(
    userId: string,
    ctx: RequestContext,
  ): Promise<TradingStatusDto> {
    if ((await this.status(userId)).tradingMode === TradingMode.PAPER)
      return this.status(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        tradingMode: TradingMode.PAPER,
        tradingModeChangedAt: new Date(),
      },
    });
    await this.audit.log({
      userId,
      action: 'mode.paper_enabled',
      entityType: 'User',
      entityId: userId,
      ...ctx,
    });
    return this.status(userId);
  }
}
