import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { LoginDto, RegisterDto, UserProfileDto } from './dto/auth.dto.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

/** Contexte de la requête, recopié dans le journal d'audit. */
export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: UserProfileDto;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const PROFILE_SELECT = {
  id: true,
  email: true,
  displayName: true,
  timezone: true,
  baseCurrency: true,
  tradingMode: true,
  killSwitchActive: true,
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** Crée le compte avec ses réglages par défaut (mode PAPER, risques et notifications) puis ouvre une session. */
  async register(dto: RegisterDto, ctx: RequestContext): Promise<Session> {
    if (this.config.get('AUTH_REGISTRATION_ENABLED') === 'false') {
      throw new ForbiddenException("L'inscription est fermée");
    }

    const passwordHash = await this.passwords.hash(dto.password);
    let user: UserProfileDto;
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          displayName: dto.displayName,
          timezone: dto.timezone,
          notificationSettings: { create: {} },
          riskSettings: { create: {} },
        },
        select: PROFILE_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Inscription impossible avec cet email');
      }
      throw error;
    }

    await this.audit.log({
      action: 'auth.registered',
      userId: user.id,
      entityType: 'User',
      entityId: user.id,
      ...ctx,
    });
    return this.openSession(user, randomUUID());
  }

  async login(dto: LoginDto, ctx: RequestContext): Promise<Session> {
    const account = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
      select: { ...PROFILE_SELECT, passwordHash: true },
    });

    const valid = await this.passwords.verify(
      account?.passwordHash,
      dto.password,
    );
    if (!account || !valid) {
      // Ni l'email ni le mot de passe ne sont journalisés.
      await this.audit.log({
        action: 'auth.login_failed',
        userId: account?.id,
        ...ctx,
      });
      throw new UnauthorizedException('Identifiants invalides');
    }

    const { passwordHash: _passwordHash, ...user } = account;
    await this.audit.log({ action: 'auth.login', userId: user.id, ...ctx });
    return this.openSession(user, randomUUID());
  }

  /**
   * Échange un refresh token contre une nouvelle paire (rotation). Un token déjà consommé qui revient
   * signale un vol probable : toute sa famille est révoquée.
   */
  async refresh(
    rawToken: string | undefined,
    ctx: RequestContext,
  ): Promise<Session> {
    if (!rawToken) throw new UnauthorizedException();

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefreshToken(rawToken) },
    });
    if (!stored) throw new UnauthorizedException();

    if (stored.revokedAt) {
      await this.revokeFamily(stored.familyId);
      await this.audit.log({
        action: 'auth.refresh_reuse_detected',
        userId: stored.userId,
        entityType: 'RefreshToken',
        entityId: stored.id,
        ...ctx,
      });
      throw new UnauthorizedException();
    }
    if (stored.expiresAt <= new Date()) throw new UnauthorizedException();

    const user = await this.prisma.user.findFirst({
      where: { id: stored.userId, deletedAt: null },
      select: PROFILE_SELECT,
    });
    if (!user) throw new UnauthorizedException();

    // Consommation atomique : si deux requêtes présentent le même token, une seule gagne.
    const consumed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (consumed.count !== 1) throw new UnauthorizedException();

    return this.openSession(user, stored.familyId);
  }

  /** Révoque la chaîne de refresh tokens ; idempotent (un token inconnu ou absent n'est pas une erreur). */
  async logout(
    rawToken: string | undefined,
    ctx: RequestContext,
  ): Promise<void> {
    if (!rawToken) return;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefreshToken(rawToken) },
    });
    if (!stored) return;
    await this.revokeFamily(stored.familyId);
    await this.audit.log({
      action: 'auth.logout',
      userId: stored.userId,
      ...ctx,
    });
  }

  async me(userId: string): Promise<UserProfileDto> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: PROFILE_SELECT,
    });
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private async openSession(
    user: UserProfileDto,
    familyId: string,
  ): Promise<Session> {
    const refreshToken = this.tokens.generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + this.tokens.refreshTtlMs);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: this.tokens.hashRefreshToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });
    return {
      accessToken: await this.tokens.signAccessToken(user.id),
      expiresIn: this.tokens.accessTtlSeconds,
      user,
      refreshToken,
      refreshExpiresAt,
    };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
