import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { RequestContext } from '../auth/auth.service.js';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import {
  ListNotificationsQuery,
  NotificationDto,
  NotificationListDto,
  NotificationSettingsDto,
  UpdateNotificationSettingsDto,
} from './dto/notifications.dto.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { NotificationService } from './notification.service.js';

/** Le message de test appelle un service externe : 3 par minute et par IP. */
const TEST_LIMIT = { default: { limit: 3, ttl: 60_000 } };

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly settings: NotificationSettingsService,
  ) {}

  @Get('settings')
  @ApiOkResponse({ type: NotificationSettingsDto })
  getSettings(@CurrentUser() user: AuthUser) {
    return this.settings.get(user.id);
  }

  @Patch('settings')
  @ApiOkResponse({ type: NotificationSettingsDto })
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateNotificationSettingsDto,
    @Req() req: Request,
  ) {
    return this.settings.update(user.id, dto, context(req));
  }

  /** Boîte de réception : les plus récentes d'abord, avec le nombre de non lues. */
  @Get()
  @ApiOkResponse({ type: NotificationListDto })
  list(@CurrentUser() user: AuthUser, @Query() query: ListNotificationsQuery) {
    return this.notifications.list(user.id, {
      limit: query.limit ?? 30,
      before: query.before ? new Date(query.before) : undefined,
      unreadOnly: query.unread,
    });
  }

  /** Envoie un message de test immédiat (sans Mode Nuit) sur les canaux activés, pour vérifier la configuration. */
  @Throttle(TEST_LIMIT)
  @Post('test')
  @HttpCode(200)
  @ApiOkResponse({ type: NotificationDto })
  async test(@CurrentUser() user: AuthUser) {
    const sent = await this.notifications.notify(user.id, {
      title: 'Notification de test',
      body: 'Si vous lisez ce message, ce canal est bien configuré.',
      immediate: true,
    });
    if (!sent) throw new NotFoundException();
    return sent;
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOkResponse({ type: NotificationDto })
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }
}

function context(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}
