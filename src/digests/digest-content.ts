import { formatNumber, formatSigned } from '../common/format.js';
import type { Prisma } from '../generated/prisma/client.js';
import { changePct } from '../notifications/engine/alert-conditions.js';

export type DigestKind = 'TODAY' | 'WEEK';

export interface DigestInput {
  kind: DigestKind;
  /** Titres des notifications non critiques mises en attente par le Mode Nuit. */
  held: string[];
  /** Titres des alertes critiques déclenchées pendant la période. */
  critical: string[];
  /** Positions suivies : null si l'utilisateur n'en a aucune. */
  portfolio: {
    /** Valeur actuelle des positions actuelles ; null si un prix manque (total non calculable). */
    valueNow: Prisma.Decimal | null;
    /** Valeur des mêmes positions aux prix du début de la période ; null si un prix manque. */
    valuePast: Prisma.Decimal | null;
  } | null;
  /** Variation de chaque position sur la période (positions dont les deux prix sont connus). */
  movers: { symbol: string; changePct: Prisma.Decimal }[];
}

export interface DigestContent {
  summary: string;
  points: string[];
  /** Variation du portefeuille sur la période, en %, arrondie à 2 décimales ; null si non calculable. */
  portfolioDeltaPct: Prisma.Decimal | null;
}

/** En dessous de ce seuil (en %), le portefeuille est dit « stable ». */
const STABLE_PCT = 0.1;
/** Au-dessus de ce seuil (en %), la nuit n'est plus qualifiée de « calme ». */
const CALM_PCT = 3;
const MAX_HELD_LISTED = 5;
const MAX_CRITICAL_LISTED = 3;

/**
 * Texte du rapport du matin. Déterministe (pas d'IA) et sobre : il constate, il ne conseille pas. Même ton calme
 * que la maquette (« Nuit calme. Votre portefeuille a progressé d'environ 1,2 %… Aucune action requise. »).
 */
export function buildDigest(input: DigestInput): DigestContent {
  const label = input.kind === 'TODAY' ? '24 h' : '7 jours';
  const valuesKnown =
    input.portfolio?.valueNow != null && input.portfolio.valuePast != null;
  const delta = valuesKnown
    ? (changePct(
        input.portfolio!.valueNow!,
        input.portfolio!.valuePast!,
      )?.toDecimalPlaces(2) ?? null)
    : null;

  const sentences: string[] = [];

  // Ouverture.
  if (input.kind === 'TODAY') {
    const calm =
      input.critical.length === 0 &&
      (delta === null || delta.abs().lt(CALM_PCT));
    if (calm) sentences.push('Nuit calme.');
  } else if (delta !== null) {
    sentences.push(
      delta.gte(1)
        ? 'Semaine positive.'
        : delta.lte(-1)
          ? 'Semaine difficile.'
          : 'Semaine stable.',
    );
  }

  // Portefeuille.
  if (input.portfolio) {
    if (delta === null) {
      sentences.push("La valeur du portefeuille n'a pas pu être calculée.");
    } else if (delta.abs().lt(STABLE_PCT)) {
      sentences.push(`Votre portefeuille est resté stable sur ${label}.`);
    } else {
      sentences.push(
        `Votre portefeuille a ${delta.isPositive() ? 'progressé' : 'reculé'} d'environ ${formatNumber(delta.abs())} % sur ${label}.`,
      );
    }
  }

  // Alertes.
  const critical = input.critical.length;
  sentences.push(
    critical === 0
      ? "Aucune alerte critique ne s'est déclenchée."
      : critical === 1
        ? "Une alerte critique s'est déclenchée."
        : `${critical} alertes critiques se sont déclenchées.`,
  );
  const held = input.held.length;
  if (held > 0) {
    sentences.push(
      held === 1
        ? 'Une alerte non urgente a été regroupée dans ce rapport.'
        : `${held} alertes non urgentes ont été regroupées dans ce rapport.`,
    );
  }
  sentences.push(
    critical > 0
      ? 'Consultez vos alertes critiques.'
      : 'Aucune action requise.',
  );

  return {
    summary: sentences.join(' '),
    points: buildPoints(input, valuesKnown),
    portfolioDeltaPct: delta,
  };
}

/** Arrondi à 2 décimales comme la synthèse, sauf si l'arrondi effacerait une variation non nulle (0,0004 % reste 0,0004 %). */
function shown(value: Prisma.Decimal): Prisma.Decimal {
  const rounded = value.toDecimalPlaces(2);
  return rounded.isZero() ? value : rounded;
}

function buildPoints(input: DigestInput, valuesKnown: boolean): string[] {
  const points: string[] = [];

  if (valuesKnown) {
    points.push(
      `Valeur du portefeuille : ${formatNumber(input.portfolio!.valueNow!)} $`,
    );
  }

  const sorted = [...input.movers].sort((a, b) =>
    b.changePct.comparedTo(a.changePct),
  );
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (best && best.changePct.gt(0))
    points.push(
      `Plus forte hausse : ${best.symbol} ${formatSigned(shown(best.changePct))} %`,
    );
  if (worst && worst.changePct.lt(0))
    points.push(
      `Plus forte baisse : ${worst.symbol} ${formatSigned(shown(worst.changePct))} %`,
    );

  for (const title of input.critical.slice(0, MAX_CRITICAL_LISTED))
    points.push(`Critique : ${title}`);
  const hidden = input.critical.length - MAX_CRITICAL_LISTED;
  if (hidden > 0)
    points.push(
      `+ ${hidden} autre${hidden > 1 ? 's' : ''} alerte${hidden > 1 ? 's' : ''} critique${hidden > 1 ? 's' : ''}`,
    );

  for (const title of input.held.slice(0, MAX_HELD_LISTED))
    points.push(`Regroupée : ${title}`);
  const heldHidden = input.held.length - MAX_HELD_LISTED;
  if (heldHidden > 0)
    points.push(
      `+ ${heldHidden} autre${heldHidden > 1 ? 's' : ''} alerte${heldHidden > 1 ? 's' : ''} regroupée${heldHidden > 1 ? 's' : ''}`,
    );

  return points;
}
