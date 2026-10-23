import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { RequestContext } from '../auth/auth.service.js';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { AlertsService } from './alerts.service.js';
import { AlertDto, CreateAlertDto, UpdateAlertDto } from './dto/alerts.dto.js';

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Post()
  @ApiOkResponse({ type: AlertDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAlertDto,
    @Req() req: Request,
  ) {
    return this.alerts.create(user.id, dto, context(req));
  }

  @Get()
  @ApiOkResponse({ type: [AlertDto] })
  list(@CurrentUser() user: AuthUser) {
    return this.alerts.list(user.id);
  }

  /** Seuil, fenêtre, canal, activation et criticité ; la condition et le symbole ne se modifient pas. */
  @Patch(':id')
  @ApiOkResponse({ type: AlertDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAlertDto,
    @Req() req: Request,
  ) {
    return this.alerts.update(user.id, id, dto, context(req));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.alerts.remove(user.id, id, context(req));
  }
}

function context(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}
