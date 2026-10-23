import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const SECRET = 'x'.repeat(48);
const dto = { email: 'client@example.com', password: 'un-mot-de-passe-solide' };

function build(env: Record<string, string> = {}) {
  const prisma = new FakePrisma();
  const config = new ConfigService({ JWT_ACCESS_SECRET: SECRET, ...env });
  const asPrisma = prisma as unknown as PrismaService;
  const service = new AuthService(
    asPrisma,
    new PasswordService(),
    new TokenService(config, new JwtService()),
    new AuditService(asPrisma),
    config,
  );
  return { prisma, service };
}

describe('AuthService', () => {
  describe('register', () => {
    it('crée le compte en mode PAPER, sans exposer le hash, et ouvre une session', async () => {
      const { prisma, service } = build();
      const session = await service.register(dto, {});

      expect(session.user).toMatchObject({
        email: dto.email,
        tradingMode: 'PAPER',
        killSwitchActive: false,
      });
      expect(session.user).not.toHaveProperty('passwordHash');
      expect(prisma.users[0].passwordHash).toMatch(/^\$argon2id\$/);
      expect(prisma.users[0].passwordHash).not.toContain(dto.password);
      expect(prisma.auditLogs.map((l) => l.action)).toContain(
        'auth.registered',
      );
    });

    it('stocke le refresh token haché, jamais en clair', async () => {
      const { prisma, service } = build();
      const session = await service.register(dto, {});
      expect(prisma.refreshTokens[0].tokenHash).not.toBe(session.refreshToken);
      expect(JSON.stringify(prisma.refreshTokens)).not.toContain(
        session.refreshToken,
      );
    });

    it('refuse un email déjà utilisé', async () => {
      const { service } = build();
      await service.register(dto, {});
      await expect(service.register(dto, {})).rejects.toThrow(
        ConflictException,
      );
    });

    it("refuse l'inscription quand elle est fermée", async () => {
      const { service } = build({ AUTH_REGISTRATION_ENABLED: 'false' });
      await expect(service.register(dto, {})).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('login', () => {
    it('connecte avec les bons identifiants', async () => {
      const { prisma, service } = build();
      await service.register(dto, {});
      const session = await service.login(dto, { ipAddress: '1.2.3.4' });
      expect(session.accessToken).toBeTruthy();
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'auth.login',
        ipAddress: '1.2.3.4',
      });
    });

    it('renvoie la même erreur pour un mauvais mot de passe et un email inconnu', async () => {
      const { prisma, service } = build();
      await service.register(dto, {});

      const wrongPassword = await service
        .login({ ...dto, password: 'mauvais' }, {})
        .catch((e) => e);
      const unknownEmail = await service
        .login({ ...dto, email: 'autre@example.com' }, {})
        .catch((e) => e);

      expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
      expect(unknownEmail).toBeInstanceOf(UnauthorizedException);
      expect(wrongPassword.message).toBe(unknownEmail.message);
      expect(
        prisma.auditLogs.filter((l) => l.action === 'auth.login_failed'),
      ).toHaveLength(2);
    });

    it('refuse un compte désactivé', async () => {
      const { prisma, service } = build();
      await service.register(dto, {});
      prisma.users[0].deletedAt = new Date();
      await expect(service.login(dto, {})).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("ne journalise ni le mot de passe ni l'email d'un échec", async () => {
      const { prisma, service } = build();
      await service
        .login({ email: 'inconnu@example.com', password: 'secret-tenté' }, {})
        .catch(() => undefined);
      const logged = JSON.stringify(prisma.auditLogs);
      expect(logged).not.toContain('secret-tenté');
      expect(logged).not.toContain('inconnu@example.com');
    });
  });

  describe('refresh', () => {
    it('fait tourner le refresh token : le nouveau fonctionne, l’ancien est consommé', async () => {
      const { prisma, service } = build();
      const first = await service.register(dto, {});
      const second = await service.refresh(first.refreshToken, {});

      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(
        prisma.refreshTokens.filter((t) => t.revokedAt === null),
      ).toHaveLength(1);
      await expect(
        service.refresh(second.refreshToken, {}),
      ).resolves.toBeDefined();
    });

    it('détecte la réutilisation d’un token consommé et révoque toute la famille', async () => {
      const { prisma, service } = build();
      const first = await service.register(dto, {});
      const second = await service.refresh(first.refreshToken, {});

      await expect(service.refresh(first.refreshToken, {})).rejects.toThrow(
        UnauthorizedException,
      );

      expect(prisma.refreshTokens.every((t) => t.revokedAt !== null)).toBe(
        true,
      );
      expect(prisma.auditLogs.map((l) => l.action)).toContain(
        'auth.refresh_reuse_detected',
      );
      await expect(service.refresh(second.refreshToken, {})).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuse un token absent, inconnu ou expiré', async () => {
      const { prisma, service } = build();
      const session = await service.register(dto, {});
      await expect(service.refresh(undefined, {})).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refresh('inconnu', {})).rejects.toThrow(
        UnauthorizedException,
      );

      prisma.refreshTokens[0].expiresAt = new Date(Date.now() - 1000);
      await expect(service.refresh(session.refreshToken, {})).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuse si le compte a été désactivé', async () => {
      const { prisma, service } = build();
      const session = await service.register(dto, {});
      prisma.users[0].deletedAt = new Date();
      await expect(service.refresh(session.refreshToken, {})).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('logout', () => {
    it('révoque la session ; idempotent', async () => {
      const { service } = build();
      const session = await service.register(dto, {});
      await service.logout(session.refreshToken, {});
      await expect(service.refresh(session.refreshToken, {})).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(
        service.logout(session.refreshToken, {}),
      ).resolves.toBeUndefined();
      await expect(service.logout(undefined, {})).resolves.toBeUndefined();
    });
  });
});
