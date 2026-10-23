import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  HoldingDto,
  RecordTransactionDto,
  SetAssetDto,
  TransactionResultDto,
} from './dto/portfolio.dto.js';
import {
  InsufficientQuantityError,
  applyBuy,
  applySell,
  type Position,
} from './portfolio-math.js';

const CONFLICT = 'La position a été modifiée en parallèle, réessayez';

type AssetRow = {
  id: string;
  symbol: string;
  quantity: Prisma.Decimal;
  avgBuyPrice: Prisma.Decimal;
  updatedAt: Date;
};

/**
 * Positions déclarées par l'utilisateur (achats, ventes, import). Les écritures sont protégées contre les
 * modifications simultanées par une mise à jour conditionnelle sur `updatedAt` : en cas de course, 409.
 */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async recordTransaction(
    userId: string,
    dto: RecordTransactionDto,
    ctx: RequestContext,
  ): Promise<TransactionResultDto> {
    const quantity = new Prisma.Decimal(dto.quantity);
    const price = new Prisma.Decimal(dto.price);
    const current = await this.find(userId, dto.symbol);

    let position: Position | null;
    let realizedPnl: Prisma.Decimal | null = null;
    if (dto.side === 'BUY') {
      position = applyBuy(current && toPosition(current), quantity, price);
    } else {
      try {
        ({ position, realizedPnl } = applySell(
          current && toPosition(current),
          quantity,
          price,
        ));
      } catch (error) {
        if (error instanceof InsufficientQuantityError) {
          throw new UnprocessableEntityException(
            'Quantité insuffisante pour cette vente',
          );
        }
        throw error;
      }
    }

    await this.write(userId, dto.symbol, current, position);
    await this.audit.log({
      userId,
      action: 'portfolio.transaction_recorded',
      entityType: 'Asset',
      metadata: {
        symbol: dto.symbol,
        side: dto.side,
        quantity: dto.quantity,
        price: dto.price,
        ...(realizedPnl && { realizedPnl: realizedPnl.toFixed() }),
      },
      ...ctx,
    });
    return {
      holding: position && toHolding(dto.symbol, position),
      realizedPnl: realizedPnl?.toFixed() ?? null,
    };
  }

  /** Définit une position telle quelle (import initial, correction). Audité avec l'ancienne valeur. */
  async setAsset(
    userId: string,
    symbol: string,
    dto: SetAssetDto,
    ctx: RequestContext,
  ): Promise<HoldingDto> {
    const current = await this.find(userId, symbol);
    const position: Position = {
      quantity: new Prisma.Decimal(dto.quantity),
      avgBuyPrice: new Prisma.Decimal(dto.avgBuyPrice).toDecimalPlaces(8),
    };
    await this.write(userId, symbol, current, position);
    await this.audit.log({
      userId,
      action: 'portfolio.asset_set',
      entityType: 'Asset',
      metadata: {
        symbol,
        from: current
          ? {
              quantity: current.quantity.toFixed(),
              avgBuyPrice: current.avgBuyPrice.toFixed(),
            }
          : null,
        to: {
          quantity: position.quantity.toFixed(),
          avgBuyPrice: position.avgBuyPrice.toFixed(),
        },
      },
      ...ctx,
    });
    return toHolding(symbol, position);
  }

  async removeAsset(
    userId: string,
    symbol: string,
    ctx: RequestContext,
  ): Promise<void> {
    const current = await this.find(userId, symbol);
    if (!current) throw new NotFoundException();
    await this.write(userId, symbol, current, null);
    await this.audit.log({
      userId,
      action: 'portfolio.asset_removed',
      entityType: 'Asset',
      metadata: {
        symbol,
        quantity: current.quantity.toFixed(),
        avgBuyPrice: current.avgBuyPrice.toFixed(),
      },
      ...ctx,
    });
  }

  list(userId: string): Promise<AssetRow[]> {
    return this.prisma.asset.findMany({
      where: { userId },
      orderBy: { symbol: 'asc' },
    });
  }

  private find(userId: string, symbol: string): Promise<AssetRow | null> {
    return this.prisma.asset.findUnique({
      where: { userId_symbol: { userId, symbol } },
    });
  }

  /** Crée, met à jour ou supprime (position `null`) en vérifiant que la ligne n'a pas changé depuis la lecture. */
  private async write(
    userId: string,
    symbol: string,
    current: AssetRow | null,
    position: Position | null,
  ): Promise<void> {
    if (!current) {
      if (!position) return;
      try {
        await this.prisma.asset.create({
          data: { userId, symbol, ...position },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(CONFLICT);
        }
        throw error;
      }
      return;
    }

    const where = { id: current.id, updatedAt: current.updatedAt };
    const { count } = position
      ? await this.prisma.asset.updateMany({ where, data: position })
      : await this.prisma.asset.deleteMany({ where });
    if (count !== 1) throw new ConflictException(CONFLICT);
  }
}

const toPosition = (row: AssetRow): Position => ({
  quantity: new Prisma.Decimal(row.quantity),
  avgBuyPrice: new Prisma.Decimal(row.avgBuyPrice),
});

const toHolding = (symbol: string, position: Position): HoldingDto => ({
  symbol,
  quantity: position.quantity.toFixed(),
  avgBuyPrice: position.avgBuyPrice.toFixed(),
});
