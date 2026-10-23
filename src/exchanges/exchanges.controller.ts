import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { RequestContext } from '../auth/auth.service.js';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import {
  CreateExchangeConfigDto,
  ExchangeConfigDto,
} from './dto/exchange.dto.js';
import { ExchangesService } from './exchanges.service.js';

/** Ces routes appellent la plateforme : 10 requêtes par minute et par IP. */
const EXTERNAL_CALL_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('exchanges')
@ApiBearerAuth()
@Controller('exchanges')
export class ExchangesController {
  constructor(private readonly exchanges: ExchangesService) {}

  /** Vérifie les permissions de la clé, la chiffre puis la stocke. Refusée si elle peut retirer des fonds. */
  @Throttle(EXTERNAL_CALL_LIMIT)
  @Post()
  @ApiOkResponse({ type: ExchangeConfigDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateExchangeConfigDto,
    @Req() req: Request,
  ) {
    return this.exchanges.create(user.id, dto, context(req));
  }

  @Get()
  @ApiOkResponse({ type: [ExchangeConfigDto] })
  list(@CurrentUser() user: AuthUser) {
    return this.exchanges.list(user.id);
  }

  @Throttle(EXTERNAL_CALL_LIMIT)
  @Post(':id/verify')
  @HttpCode(200)
  @ApiOkResponse({ type: ExchangeConfigDto })
  verify(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.exchanges.verify(user.id, id, context(req));
  }

  @Post(':id/disable')
  @HttpCode(200)
  @ApiOkResponse({ type: ExchangeConfigDto })
  disable(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.exchanges.disable(user.id, id, context(req));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.exchanges.remove(user.id, id, context(req));
  }
}

function context(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}
