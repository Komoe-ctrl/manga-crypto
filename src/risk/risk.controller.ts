import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { RequestContext } from '../auth/auth.service.js';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import {
  RiskSettingsDto,
  SwitchToLiveDto,
  TradingStatusDto,
  UpdateRiskSettingsDto,
} from './dto/risk.dto.js';
import { RiskSettingsService } from './risk-settings.service.js';
import { TradingControlService } from './trading-control.service.js';

/** Le passage en LIVE demande un mot de passe : 5 tentatives par minute et par IP. */
const LIVE_LIMIT = { default: { limit: 5, ttl: 60_000 } };

@ApiTags('risk')
@ApiBearerAuth()
@Controller('risk')
export class RiskController {
  constructor(
    private readonly settings: RiskSettingsService,
    private readonly control: TradingControlService,
  ) {}

  @Get('settings')
  @ApiOkResponse({ type: RiskSettingsDto })
  getSettings(@CurrentUser() user: AuthUser) {
    return this.settings.get(user.id);
  }

  @Patch('settings')
  @ApiOkResponse({ type: RiskSettingsDto })
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateRiskSettingsDto,
    @Req() req: Request,
  ) {
    return this.settings.update(user.id, dto, context(req));
  }

  @Get('status')
  @ApiOkResponse({ type: TradingStatusDto })
  status(@CurrentUser() user: AuthUser) {
    return this.control.status(user.id);
  }

  /** Arrête le robot en un clic. */
  @Post('kill-switch/activate')
  @HttpCode(200)
  @ApiOkResponse({ type: TradingStatusDto })
  activateKillSwitch(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.control.activateKillSwitch(user.id, context(req));
  }

  @Post('kill-switch/deactivate')
  @HttpCode(200)
  @ApiOkResponse({ type: TradingStatusDto })
  deactivateKillSwitch(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.control.deactivateKillSwitch(user.id, context(req));
  }

  /** Passage en LIVE : mot de passe et phrase de confirmation requis. */
  @Throttle(LIVE_LIMIT)
  @Post('mode/live')
  @HttpCode(200)
  @ApiOkResponse({ type: TradingStatusDto })
  switchToLive(
    @CurrentUser() user: AuthUser,
    @Body() dto: SwitchToLiveDto,
    @Req() req: Request,
  ) {
    return this.control.switchToLive(user.id, dto, context(req));
  }

  @Post('mode/paper')
  @HttpCode(200)
  @ApiOkResponse({ type: TradingStatusDto })
  switchToPaper(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.control.switchToPaper(user.id, context(req));
  }
}

function context(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}
