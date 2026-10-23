/**
 * Jour calendaire d'un utilisateur, dans son fuseau IANA. Le jour sert de clé aux instantanés d'ouverture
 * et la pause sur perte journalière dure jusqu'au prochain minuit local.
 */

/** Créer un `Intl.DateTimeFormat` coûte environ 1 ms : un par fuseau, réutilisé. */
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

const parts = (instant: Date, timeZone: string) =>
  Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;

/** Minutes écoulées depuis minuit local (0 à 1439) à cet instant, dans le fuseau donné. */
export function localMinuteOf(instant: Date, timeZone: string): number {
  const { hour, minute } = parts(instant, timeZone);
  return hour * 60 + minute;
}

/** Date locale « YYYY-MM-DD » de l'instant dans le fuseau donné. */
export function localDateOf(instant: Date, timeZone: string): string {
  const { year, month, day } = parts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Décalage du fuseau par rapport à UTC à cet instant, en millisecondes (positif à l'est de Greenwich). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Premier instant du jour local suivant (minuit local). Gère l'heure d'été : un jour peut durer 23 h ou 25 h,
 * et les fuseaux à demi-heure (Inde, Népal). Si minuit n'existe pas ce jour-là (changement d'heure à minuit),
 * renvoie le premier instant existant du jour.
 */
export function nextLocalMidnight(now: Date, timeZone: string): Date {
  const [year, month, day] = localDateOf(now, timeZone).split('-').map(Number);
  // Minuit du lendemain « comme si » le fuseau était UTC, corrigé du décalage réel ; deux passes
  // car le décalage peut changer entre l'estimation et l'instant trouvé (changement d'heure).
  const wallClock = Date.UTC(year, month - 1, day + 1);
  const first = wallClock - offsetMs(new Date(wallClock), timeZone);
  return new Date(wallClock - offsetMs(new Date(first), timeZone));
}
