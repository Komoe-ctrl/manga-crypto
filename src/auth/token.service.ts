import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';

const MIN_SECRET_LENGTH = 32;
const ALGORITHM = 'HS256';

export interface AccessTokenPayload {
  sub: string;
}

/** Access tokens JWT (courts, sans état) et refresh tokens opaques (longs, stockés hachés en base). */
@Injectable()
export class TokenService {
  private readonly secret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlMs: number;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    const secret = config.get<string>('JWT_ACCESS_SECRET');
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_ACCESS_SECRET doit contenir au moins ${MIN_SECRET_LENGTH} caractères`,
      );
    }
    this.secret = secret;
    this.accessTtlSeconds = Number(config.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
    this.refreshTtlMs =
      Number(config.get('REFRESH_TOKEN_TTL_DAYS') ?? 7) * 24 * 60 * 60 * 1000;
  }

  signAccessToken(userId: string): Promise<string> {
    const payload: AccessTokenPayload = { sub: userId };
    return this.jwt.signAsync(payload, {
      secret: this.secret,
      algorithm: ALGORITHM,
      expiresIn: this.accessTtlSeconds,
    });
  }

  /** Lève une erreur si le token est invalide ou expiré. */
  verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    return this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: this.secret,
      algorithms: [ALGORITHM],
    });
  }

  /** Token opaque de 256 bits ; seule sa valeur hachée (`hashRefreshToken`) est stockée. */
  generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
