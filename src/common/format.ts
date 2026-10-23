import type { Prisma } from '../generated/prisma/client.js';

const standard = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
/** En dessous de 1, des chiffres significatifs plutôt que des décimales : 0,0001 % ne doit pas s'afficher « 0 % ». */
const small = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 4 });

/**
 * Nombre à la française pour un message (alerte, rapport) : 2 décimales au plus, 4 chiffres significatifs sous 1.
 * Les espaces insécables du formatage sont remplacés par des espaces simples (Telegram, journaux, tests).
 */
export function formatNumber(value: Prisma.Decimal): string {
  const n = value.toNumber();
  const formatter = n !== 0 && Math.abs(n) < 1 ? small : standard;
  return formatter.format(n).replace(/\s/g, ' ');
}

/** Nombre avec son signe explicite : « +1,2 », « −3,4 » (vrai signe moins), « 0 ». */
export function formatSigned(value: Prisma.Decimal): string {
  const text = formatNumber(value.abs());
  if (value.isZero()) return text;
  return `${value.isNegative() ? '−' : '+'}${text}`;
}
