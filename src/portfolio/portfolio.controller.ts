import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { RequestContext } from '../auth/auth.service.js';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import {
  HoldingDto,
  PortfolioDto,
  RecordTransactionDto,
  SetAssetDto,
  TransactionResultDto,
} from './dto/portfolio.dto.js';
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
  ) {}

  /** Positions valorisées en USD. Si les prix sont indisponibles : `complete: false`, valeurs `null`. */
  @Get()
  @ApiOkResponse({ type: PortfolioDto })
  get(@CurrentUser() user: AuthUser) {
    return this.valuation.valuate(user.id);
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
