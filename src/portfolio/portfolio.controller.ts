import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { RequestContext } from '../auth/auth.service.js';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import {
  HoldingDto,
  ListOperationsQuery,
  OperationListDto,
  PortfolioDto,
  RecordTransactionDto,
  SetAssetDto,
  TransactionResultDto,
  TrendsDto,
} from './dto/portfolio.dto.js';
import { PortfolioTrendsService } from './portfolio-trends.service.js';
import { PortfolioValuationService } from './portfolio-valuation.service.js';
import { PortfolioService } from './portfolio.service.js';
import { SymbolPipe } from './symbol.pipe.js';

@ApiTags('portfolio')
@ApiBearerAuth()
@Controller('portfolio')
export class PortfolioController {
  constructor(
    private readonly portfolio: PortfolioService,
    private readonly valuation: PortfolioValuationService,
    private readonly trends: PortfolioTrendsService,
  ) {}

  /** Positions valorisées en USD. Si les prix sont indisponibles : `complete: false`, valeurs `null`. */
  @Get()
  @ApiOkResponse({ type: PortfolioDto })
  get(@CurrentUser() user: AuthUser) {
    return this.valuation.valuate(user.id);
  }

  /**
   * Variation sur 24 h et 7 jours, courbe et état du marché. Une source de prix en panne donne une réponse partielle
   * (`complete: false`), pas une erreur.
   */
  @Get('trends')
  @ApiOkResponse({ type: TrendsDto })
  getTrends(@CurrentUser() user: AuthUser) {
    return this.trends.trends(user.id);
  }

  /**
   * Historique des achats, ventes, corrections et retraits (les plus récents d'abord), et gain réalisé cumulé. Les
   * ordres exécutés y figurent aussi ; leur jambe en USDT est masquée.
   */
  @Get('operations')
  @ApiOkResponse({ type: OperationListDto })
  operations(
    @CurrentUser() user: AuthUser,
    @Query() query: ListOperationsQuery,
  ) {
    return this.portfolio.listOperations(user.id, {
      symbol: query.symbol,
      limit: query.limit ?? 30,
      before: query.before ? new Date(query.before) : undefined,
    });
  }

  /** Achat ou vente déclaré : met à jour la quantité et le prix moyen. */
  @Post('transactions')
  @ApiOkResponse({ type: TransactionResultDto })
  @HttpCode(200)
  record(
    @CurrentUser() user: AuthUser,
    @Body() dto: RecordTransactionDto,
    @Req() req: Request,
  ) {
    return this.portfolio.recordTransaction(user.id, dto, context(req));
  }

  /** Définit une position telle quelle (import initial ou correction). */
  @Put('assets/:symbol')
  @ApiOkResponse({ type: HoldingDto })
  set(
    @CurrentUser() user: AuthUser,
    @Param('symbol', SymbolPipe) symbol: string,
    @Body() dto: SetAssetDto,
    @Req() req: Request,
  ) {
    return this.portfolio.setAsset(user.id, symbol, dto, context(req));
  }

  @Delete('assets/:symbol')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('symbol', SymbolPipe) symbol: string,
    @Req() req: Request,
  ) {
    return this.portfolio.removeAsset(user.id, symbol, context(req));
  }
}

function context(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}
