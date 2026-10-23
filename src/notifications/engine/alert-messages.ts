import type { Prisma } from '../../generated/prisma/client.js';
import { AlertCondition } from '../../generated/prisma/enums.js';
import { changePct } from './alert-conditions.js';

const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
/** Espaces insécables du formatage français remplacés par une espace simple (messages Telegram, journaux, tests). */
/** En dessous de 1, des chiffres significatifs plutôt que des décimales : 0,0001 % ne doit pas s'afficher « 0 % ». */
const small = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 4 });
const fmt = (value: Prisma.Decimal) => {
  const n = value.toNumber();
  const formatter = n !== 0 && Math.abs(n) < 1 ? small : number;
  return formatter.format(n).replace(/[  ]/g, ' ');
};

/** « 1 h », « 24 h », « 7 jours », « 45 min ». */
export function windowLabel(minutes: number): string {
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} min`;
  if (minutes % 1440 === 0 && minutes >= 2880) return `${minutes / 1440} jours`;
  return `${minutes / 60} h`;
}

export interface AlertToDescribe {
  condition: AlertCondition;
  assetSymbol: string | null;
  threshold: Prisma.Decimal;
  windowMinutes: number | null;
}

export interface Observed {
  current: Prisma.Decimal;
  past: Prisma.Decimal | null;
}

/** Titre et texte de la notification d'une alerte déclenchée (même tournure que les alertes de la maquette). */
export function describeAlert(
  alert: AlertToDescribe,
  observed: Observed,
): { title: string; body: string } {
  const symbol = alert.assetSymbol ?? '';
  const window = alert.windowMinutes ? windowLabel(alert.windowMinutes) : '';
  const threshold = fmt(alert.threshold);
  const change =
    observed.past === null ? null : changePct(observed.current, observed.past);
  const actual = change ? fmt(change.abs()) : threshold;

  switch (alert.condition) {
    case AlertCondition.PRICE_CROSS_ABOVE:
      return {
        title: `${symbol} franchit ${threshold} $ à la hausse`,
        body: `Prix actuel de ${symbol} : ${fmt(observed.current)} $ (seuil : ${threshold} $).`,
      };
    case AlertCondition.PRICE_CROSS_BELOW:
      return {
        title: `${symbol} passe sous ${threshold} $`,
        body: `Prix actuel de ${symbol} : ${fmt(observed.current)} $ (seuil : ${threshold} $).`,
      };
    case AlertCondition.PRICE_DROP_PCT:
      return {
        title: `${symbol} −${threshold} % en ${window}`,
        body: `${symbol} a baissé de ${actual} % sur ${window} (prix actuel : ${fmt(observed.current)} $).`,
      };
    case AlertCondition.PRICE_RISE_PCT:
      return {
        title: `${symbol} +${threshold} % sur ${window}`,
        body: `${symbol} a progressé de ${actual} % sur ${window} (prix actuel : ${fmt(observed.current)} $).`,
      };
    case AlertCondition.PORTFOLIO_DROP_PCT:
      return {
        title: `Portefeuille −${threshold} % sur ${window}`,
        body: `La valeur de votre portefeuille a baissé de ${actual} % sur ${window} (valeur actuelle : ${fmt(observed.current)} $).`,
      };
  }
}
