import { localMinuteOf } from '../common/local-day.js';

/**
 * Vrai si l'instant tombe dans la plage du Mode Nuit de l'utilisateur, dans son fuseau.
 * Les bornes sont des minutes depuis minuit local : début inclus, fin exclue. La plage peut passer minuit
 * (22:00 → 07:00). Début = fin : plage vide, jamais « nuit » (une plage de 24 h n'a pas de sens).
 */
export function isInNightWindow(
  now: Date,
  timeZone: string,
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute === endMinute) return false;
  const minute = localMinuteOf(now, timeZone);
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}
