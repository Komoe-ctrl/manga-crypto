import {
  localDateOf,
  localWeekday,
  nextLocalMidnight,
  startOfLocalDay,
} from './local-day.js';

const at = (iso: string) => new Date(iso);

describe('startOfLocalDay', () => {
  it.each([
    ['UTC', '2026-10-23T10:00:00Z', '2026-10-23T00:00:00.000Z'],
    ['Europe/Paris', '2026-10-23T10:00:00Z', '2026-10-22T22:00:00.000Z'], // minuit à UTC+2
    ['Asia/Kolkata', '2026-10-23T10:00:00Z', '2026-10-22T18:30:00.000Z'],
    // Jour de 25 h (retour à l'heure d'hiver, 25/10/2026) : le jour commence à minuit en heure d'été (UTC+2).
    ['Europe/Paris', '2026-10-25T10:00:00Z', '2026-10-24T22:00:00.000Z'],
    // Jour de 23 h (passage à l'heure d'été, 29/03/2026) : le jour commence à minuit en heure d'hiver (UTC+1).
    ['Europe/Paris', '2026-03-29T10:00:00Z', '2026-03-28T23:00:00.000Z'],
    ['America/New_York', '2026-11-01T12:00:00Z', '2026-11-01T04:00:00.000Z'], // minuit en EDT (UTC-4)
  ])('%s à %s → %s', (zone, now, expected) => {
    expect(startOfLocalDay(at(now), zone).toISOString()).toBe(expected);
  });

  it('est cohérent avec nextLocalMidnight : début + durée du jour = minuit suivant', () => {
    for (const zone of [
      'UTC',
      'Europe/Paris',
      'Asia/Kolkata',
      'America/New_York',
      'Pacific/Kiritimati',
    ]) {
      for (
        let t = at('2026-01-01T00:00:00Z').getTime();
        t < at('2027-01-01T00:00:00Z').getTime();
        t += 7.7 * 3_600_000
      ) {
        const now = new Date(t);
        const start = startOfLocalDay(now, zone);
        const next = nextLocalMidnight(now, zone);
        expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(next.getTime()).toBeGreaterThan(now.getTime());
        expect(localDateOf(start, zone)).toBe(localDateOf(now, zone));
        // Le jour dure de 23 à 25 h.
        const hours = (next.getTime() - start.getTime()) / 3_600_000;
        expect(hours).toBeGreaterThanOrEqual(23);
        expect(hours).toBeLessThanOrEqual(25);
      }
    }
  });
});

describe('localWeekday', () => {
  it.each([
    ['UTC', '2026-10-26T12:00:00Z', 1], // lundi
    ['UTC', '2026-10-25T12:00:00Z', 0], // dimanche
    ['UTC', '2026-10-24T12:00:00Z', 6], // samedi
    // Dimanche 25 à 23:30 UTC = lundi 26 à 00:30 à Paris (UTC+1) : le jour local est lundi.
    ['Europe/Paris', '2026-10-25T23:30:00Z', 1],
    ['America/Los_Angeles', '2026-10-26T03:00:00Z', 0], // dimanche 25 à 20:00 à Los Angeles
  ])('%s à %s → %i', (zone, now, expected) => {
    expect(localWeekday(at(now), zone)).toBe(expected);
  });
});
