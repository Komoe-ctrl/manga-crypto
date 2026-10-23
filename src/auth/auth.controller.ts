import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AuthService,
  type RequestContext,
  type Session,
} from './auth.service.js';
import { CurrentUser, Public, type AuthUser } from './decorators.js';
import {
  AuthResponseDto,
  LoginDto,
  RegisterDto,
  UserProfileDto,
} from './dto/auth.dto.js';

const REFRESH_COOKIE = 'refresh_token';
/** Le cookie n'est envoyé qu'aux routes d'authentification. */
const REFRESH_COOKIE_PATH = '/api/auth';
/** 5 tentatives par minute et par IP sur les routes sensibles. */
const STRICT_LIMIT = { default: { limit: 5, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(STRICT_LIMIT)
  @Post('register')
  @ApiOkResponse({ type: AuthResponseDto })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.register(dto, context(req)));
  }

  @Public()
  @Throttle(STRICT_LIMIT)
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ type: AuthResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.login(dto, context(req)));
  }

  /** Lit le refresh token dans le cookie `httpOnly` et renvoie un nouvel access token (rotation du refresh token). */
  @Public()
  @Throttle(STRICT_LIMIT)
  @Post('refresh')
  @HttpCode(200)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOkResponse({ type: AuthResponseDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      return this.respond(
        res,
        await this.auth.refresh(readCookie(req, REFRESH_COOKIE), context(req)),
      );
    } catch (error) {
      clearRefreshCookie(res);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth(REFRESH_COOKIE)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(readCookie(req, REFRESH_COOKIE), context(req));
    clearRefreshCookie(res);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: UserProfileDto })
  me(@CurrentUser() user: AuthUser): Promise<UserProfileDto> {
    return this.auth.me(user.id);
  }

  /** Pose le refresh token en cookie et renvoie le reste de la session dans le corps. */
  private respond(res: Response, session: Session): AuthResponseDto {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: REFRESH_COOKIE_PATH,
      expires: session.refreshExpiresAt,
    });
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

function context(req: Request): RequestContext {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

/** Lecture minimale de l'en-tête Cookie (évite la dépendance `cookie-parser`). */
function readCookie(req: Request, name: string): string | undefined {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}
