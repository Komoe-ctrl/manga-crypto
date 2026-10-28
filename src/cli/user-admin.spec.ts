import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import {
  MAX_PASSWORD,
  MIN_PASSWORD,
  UserAdminError,
  createUser,
  normalizeEmail,
  resetPassword,
  validatePassword,
} from './user-admin.js';

const PASSWORD = 'un-mot-de-passe-solide';

function build() {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const passwords = new PasswordService();
  return {
    prisma,
    passwords,
    create: (input: Partial<Parameters<typeof createUser>[3]> = {}) =>
      createUser(asPrisma, passwords, new AuditService(asPrisma), {
        email: 'client@example.com',
        password: PASSWORD,
        ...input,
      }),
    reset: (email: string, password: string) =>
      resetPassword(
        asPrisma,
        passwords,
        new AuditService(asPrisma),
        email,
        password,
      ),
  };
}

describe('validatePassword', () => {
  it('accepte de 12 à 128 caractères', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD))).toBeNull();
    expect(validatePassword('a'.repeat(MAX_PASSWORD))).toBeNull();
  });
  it('refuse trop court et trop long, avec la limite dans le message', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD - 1))).toContain('12');
    expect(validatePassword('a'.repeat(MAX_PASSWORD + 1))).toContain('128');
    expect(validatePassword('')).toContain('12');
  });
});

describe('normalizeEmail', () => {
  it('retire les espaces et passe en minuscules, comme l’inscription', () => {
    expect(normalizeEmail('  Client@Example.COM ')).toBe('client@example.com');
  });
});

describe('createUser', () => {
  it('crée le compte avec un mot de passe haché (jamais en clair) qui permet de se connecter', async () => {
    const { prisma, passwords, create } = build();
    const user = await create();

    expect(user.email).toBe('client@example.com');
    const stored = prisma.users[0];
    expect(stored.passwordHash).not.toContain(PASSWORD);
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await passwords.verify(stored.passwordHash, PASSWORD)).toBe(true);
    expect(
      await passwords.verify(stored.passwordHash, 'un-autre-mot-de-passe'),
    ).toBe(false);
  });

  it('normalise l’e-mail : on se connecte avec la même adresse qu’à l’inscription', async () => {
    const { prisma, create } = build();
    await create({ email: '  Client@Example.COM ' });
    expect(prisma.users[0].email).toBe('client@example.com');
  });

  it('donne au compte les réglages par défaut (notifications et risque) et le mode simulation', async () => {
    const { prisma, create } = build();
    const { id } = await create();
    expect(prisma.notificationSettingsRows.some((r) => r.userId === id)).toBe(
      true,
    );
    expect(prisma.riskSettingsRows.some((r) => r.userId === id)).toBe(true);
    expect(prisma.users[0].tradingMode).toBe('PAPER');
  });

  it('garde le nom affiché et le fuseau demandés', async () => {
    const { prisma, create } = build();
    await create({ displayName: 'Awa Diop', timezone: 'Africa/Dakar' });
    expect(prisma.users[0]).toMatchObject({
      displayName: 'Awa Diop',
      timezone: 'Africa/Dakar',
    });
  });

  it('écrit dans le journal d’audit, sans jamais y mettre le mot de passe', async () => {
    const { prisma, create } = build();
    const { id } = await create();
    expect(prisma.auditLogs.at(-1)).toMatchObject({
      action: 'auth.account_created_by_admin',
      userId: id,
      entityType: 'User',
    });
    expect(JSON.stringify(prisma.auditLogs)).not.toContain(PASSWORD);
    expect(JSON.stringify(prisma.auditLogs)).not.toContain('argon2');
  });

  it.each([
    ['pas-un-email'],
    ['a@'],
    ['@example.com'],
    [''],
    [`${'a'.repeat(250)}@example.com`],
  ])('refuse l’adresse %j, sans rien créer', async (email) => {
    const { prisma, create } = build();
    await expect(create({ email })).rejects.toBeInstanceOf(UserAdminError);
    expect(prisma.users).toHaveLength(0);
  });

  it('refuse un mot de passe trop court, sans rien créer', async () => {
    const { prisma, create } = build();
    await expect(create({ password: 'court' })).rejects.toThrow(/au moins 12/);
    expect(prisma.users).toHaveLength(0);
  });

  it('refuse un fuseau horaire inconnu et un nom trop long', async () => {
    const { prisma, create } = build();
    await expect(create({ timezone: 'Mars/Olympus' })).rejects.toThrow(
      /Fuseau horaire inconnu/,
    );
    await expect(create({ displayName: 'x'.repeat(81) })).rejects.toThrow(
      /80 caractères/,
    );
    expect(prisma.users).toHaveLength(0);
  });

  it('refuse un compte déjà existant, même écrit autrement, sans rien modifier', async () => {
    const { prisma, create } = build();
    await create();
    const hash = prisma.users[0].passwordHash;
    await expect(
      create({
        email: 'CLIENT@example.com',
        password: 'un-autre-mot-de-passe',
      }),
    ).rejects.toThrow(/existe déjà/);
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0].passwordHash).toBe(hash);
  });
});

describe('resetPassword', () => {
  it('remplace le mot de passe : l’ancien ne marche plus, le nouveau oui', async () => {
    const { prisma, passwords, create, reset } = build();
    await create();
    await reset('client@example.com', 'un-nouveau-mot-de-passe');

    const hash = prisma.users[0].passwordHash;
    expect(await passwords.verify(hash, 'un-nouveau-mot-de-passe')).toBe(true);
    expect(await passwords.verify(hash, PASSWORD)).toBe(false);
  });

  it('ferme toutes les sessions actives du compte, et seulement les siennes', async () => {
    const { prisma, create, reset } = build();
    const { id } = await create();
    const other = await create({ email: 'autre@example.com' });
    const session = (userId: string, revokedAt: Date | null = null) => ({
      id: crypto.randomUUID(),
      userId,
      tokenHash: crypto.randomUUID(),
      familyId: crypto.randomUUID(),
      revokedAt,
    });
    const alreadyClosed = new Date('2026-01-01T00:00:00Z');
    prisma.refreshTokens.push(
      session(id),
      session(id),
      session(id, alreadyClosed),
      session(other.id),
    );

    const result = await reset('client@example.com', 'un-nouveau-mot-de-passe');

    expect(result.revokedSessions).toBe(2); // les deux actives ; la troisième l'était déjà
    const mine = prisma.refreshTokens.filter((t) => t.userId === id);
    expect(mine.every((t) => t.revokedAt !== null)).toBe(true);
    expect(mine.find((t) => t.revokedAt === alreadyClosed)).toBeDefined(); // sa date d'origine est conservée
    expect(
      prisma.refreshTokens.find((t) => t.userId === other.id)!.revokedAt,
    ).toBeNull();
  });

  it('écrit dans le journal d’audit le nombre de sessions fermées, sans mot de passe', async () => {
    const { prisma, create, reset } = build();
    await create();
    await reset('client@example.com', 'un-nouveau-mot-de-passe');
    expect(prisma.auditLogs.at(-1)).toMatchObject({
      action: 'auth.password_reset_by_admin',
      metadata: { revokedSessions: 0 },
    });
    expect(JSON.stringify(prisma.auditLogs)).not.toContain(
      'un-nouveau-mot-de-passe',
    );
  });

  it('trouve le compte quelle que soit la casse de l’adresse', async () => {
    const { create, reset } = build();
    await create();
    await expect(
      reset('  CLIENT@example.com ', 'un-nouveau-mot-de-passe'),
    ).resolves.toEqual({ revokedSessions: 0 });
  });

  it('refuse un compte inconnu, sans rien modifier', async () => {
    const { prisma, create, reset } = build();
    await create();
    const hash = prisma.users[0].passwordHash;
    await expect(
      reset('inconnu@example.com', 'un-nouveau-mot-de-passe'),
    ).rejects.toThrow(/Aucun compte/);
    expect(prisma.users[0].passwordHash).toBe(hash);
  });

  it('ignore un compte supprimé', async () => {
    const { prisma, create, reset } = build();
    await create();
    prisma.users[0].deletedAt = new Date();
    await expect(
      reset('client@example.com', 'un-nouveau-mot-de-passe'),
    ).rejects.toThrow(/Aucun compte/);
  });

  it('refuse un nouveau mot de passe trop court : l’ancien reste valable et les sessions ouvertes aussi', async () => {
    const { prisma, passwords, create, reset } = build();
    const { id } = await create();
    prisma.refreshTokens.push({
      id: '1',
      userId: id,
      tokenHash: 'h',
      familyId: 'f',
      revokedAt: null,
    });

    await expect(reset('client@example.com', 'court')).rejects.toThrow(
      /au moins 12/,
    );

    expect(await passwords.verify(prisma.users[0].passwordHash, PASSWORD)).toBe(
      true,
    );
    expect(prisma.refreshTokens[0].revokedAt).toBeNull();
  });
});
