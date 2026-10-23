import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthUser } from '../auth/decorators.js';
import {
  DigestDto,
  DigestListDto,
  ListDigestsQuery,
} from './dto/digests.dto.js';
import { DigestsService } from './digests.service.js';

@ApiTags('digests')
@ApiBearerAuth()
@Controller('digests')
export class DigestsController {
  constructor(private readonly digests: DigestsService) {}

  /** Rapports du matin, les plus récents d'abord, avec le nombre de non lus. */
  @Get()
  @ApiOkResponse({ type: DigestListDto })
  list(@CurrentUser() user: AuthUser, @Query() query: ListDigestsQuery) {
    return this.digests.list(user.id, {
      limit: query.limit ?? 30,
      before: query.before ? new Date(query.before) : undefined,
      period: query.period,
    });
  }

  @Get(':id')
  @ApiOkResponse({ type: DigestDto })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.digests.get(user.id, id);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOkResponse({ type: DigestDto })
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.digests.markRead(user.id, id);
  }
}
