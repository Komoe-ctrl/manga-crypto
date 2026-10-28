import { isEmail } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { TIMEZONES } from '../auth/dto/auth.dto.js';
import { PasswordService } from '../auth/password.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Gestion des comptes en ligne de commande (`npm run user:create`, `npm run user:password`), pour un produit à clients
 * connus : l'inscription publique est fermée (`AUTH_REGISTRATION_ENABLED=false`) et l'administrateur crée le compte.
 * Mêmes règles que l'inscription (e-mail normalisé, mot de passe de 12 à 128 caractères, argon2id, réglages par défaut)
 * pour que le compte créé ici se connecte comme n'importe quel autre.
 */

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;

/** Une erreur attendue (saisie invalide, compte déjà là ou absent) : son message est montré tel quel à l'administrateur. */
export class UserAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserAdminError';
  }
}

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

/** Message d'erreur, ou `null` si le mot de passe est acceptable. */
export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD)
    return `Le mot de passe doit faire au moins ${MIN_PASSWORD} caractères.`;
  if (password.length > MAX_PASSWORD)
    return `Le mot de passe ne doit pas dépasser ${MAX_PASSWORD} caractères.`;
  return null;
}

function check(email: string, password: string): string {
  const normalized = normalizeEmail(email);
  if (!isEmail(normalized) || normalized.length > 254)
    throw new UserAdminError(`Adresse e-mail invalide : « ${email} ».`);
  const problem = validatePassword(password);
  if (problem) throw new UserAdminError(problem);
  return normalized;
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName?: string;
  timezone?: string;
}

/** Crée un compte comme le fait l'inscription (réglages de notification et de risque par défaut), sans ouvrir de session. */
export async function createUser(
  prisma: PrismaService,
  passwords: PasswordService,
  audit: AuditService,
  input: CreateUserInput,
): Promise<{ id: string; email: string }> {
  const email = check(input.email, input.password);
  if (input.timezone !== undefined && !TIMEZONES.includes(input.timezone))
    throw new UserAdminError(`Fuseau horaire inconnu : « ${input.timezone} ».`);
  if (input.displayName !== undefined && input.displayName.length > 80)
    throw new UserAdminError(
      'Le nom affiché ne doit pas dépasser 80 caractères.',
    );

  const existing = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  });
  if (existing)
    throw new UserAdminError(`Un compte existe déjà avec l'adresse ${email}.`);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await passwords.hash(input.password),
      displayName: input.displayName,
      timezone: input.timezone,
      notificationSettings: { create: {} },
      riskSettings: { create: {} },
    },
    select: { id: true, email: true },
  });
  await audit.log({
    action: 'auth.account_created_by_admin',
    userId: user.id,
    entityType: 'User',
    entityId: user.id,
  });
  return user;
}

/**
 * Remplace le mot de passe d'un compte et **ferme toutes ses sessions** : un appareil resté connecté avec l'ancien mot de
 * passe (ou un jeton volé) ne survit pas à la réinitialisation. Renvoie le nombre de sessions fermées.
 */
export async function resetPassword(
  prisma: PrismaService,
  passwords: PasswordService,
  audit: AuditService,
  emailInput: string,
  password: string,
): Promise<{ revokedSessions: number }> {
  const email = check(emailInput, password);
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true },
  });
  if (!user) throw new UserAdminError(`Aucun compte avec l'adresse ${email}.`);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await passwords.hash(password) },
  });
  const { count } = await prisma.refreshToken.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit.log({
    action: 'auth.password_reset_by_admin',
    userId: user.id,
    entityType: 'User',
    entityId: user.id,
    metadata: { revokedSessions: count },
  });
  return { revokedSessions: count };
}
