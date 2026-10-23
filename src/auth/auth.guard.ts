import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service.js';
import { IS_PUBLIC_KEY, type AuthenticatedRequest } from './decorators.js';
import { TokenService } from './token.service.js';

/** Garde globale : exige un access token valide et un utilisateur actif, sauf sur les routes `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException();

    let userId: string;
    try {
      userId = (await this.tokens.verifyAccessToken(token)).sub;
    } catch {
      throw new UnauthorizedException();
    }

    // Un compte désactivé perd l'accès immédiatement, sans attendre l'expiration du token.
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true },
    });
    if (!user) throw new UnauthorizedException();

    request.user = user;
    return true;
  }
}
