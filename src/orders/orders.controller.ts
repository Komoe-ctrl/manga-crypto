import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { RequestContext } from '../auth/auth.service.js';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderOrigin, OrderStatus } from '../generated/prisma/enums.js';
import {
  CreateOrderDto,
  ListOrdersQuery,
  OrderDto,
  OrderListDto,
} from './dto/orders.dto.js';
import { REJECTION_MESSAGES, isRejectionReason } from './order-rules.js';
import { OrdersService } from './orders.service.js';

/** Un ordre peut mettre de l'argent en jeu : 10 par minute et par IP. */
const ORDER_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Passe un ordre manuel au marché (mode PAPER uniquement). Les garde-fous s'appliquent comme pour tout ordre :
   * robot actif, exposition maximale, fonds. Un ordre refusé est enregistré et renvoyé avec son motif (422).
   */
  @Throttle(ORDER_LIMIT)
  @Post()
  @ApiOkResponse({ type: OrderDto })
  @ApiUnprocessableEntityResponse({
    description:
      'Ordre refusé par un garde-fou ; `order.failureReason` donne le motif',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrderDto,
    @Req() req: Request,
  ) {
    const order = await this.orders.submit(
      user.id,
      {
        symbol: dto.symbol,
        side: dto.side,
        quantity: new Prisma.Decimal(dto.quantity),
        origin: OrderOrigin.MANUAL,
      },
      context(req),
    );
    if (order.status === OrderStatus.REJECTED) {
      const reason = isRejectionReason(order.failureReason)
        ? order.failureReason
        : null;
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: reason ? REJECTION_MESSAGES[reason] : 'Ordre refusé',
        order,
      });
    }
    return order;
  }

  @Get()
  @ApiOkResponse({ type: OrderListDto })
  list(@CurrentUser() user: AuthUser, @Query() query: ListOrdersQuery) {
    return this.orders.list(user.id, {
      limit: query.limit ?? 30,
      before: query.before ? new Date(query.before) : undefined,
      status: query.status,
    });
  }

  @Get(':id')
  @ApiOkResponse({ type: OrderDto })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user.id, id);
  }

  /** Annule un ordre pas encore pris en charge (`PENDING`) ; 409 s'il est déjà parti. */
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOkResponse({ type: OrderDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.orders.cancel(user.id, id, context(req));
  }
}

function context(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}
