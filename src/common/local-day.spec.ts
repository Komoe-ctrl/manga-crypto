import { localDateOf, nextLocalMidnight } from './local-day.js';

const at = (iso: string) => new Date(iso);

describe('localDateOf', () => {
  const instant = at('2026-10-23T22:30:00Z');

  it.each([
    ['UTC', '2026-10-23'],
    ['Europe/Paris', '2026-10-24'], // UTC+2 : 00:30 le lendemain
    ['America/Los_Angeles', '2026-10-23'], // UTC-7 : 15:30
    ['Asia/Kolkata', '2026-10-24'], // UTC+5:30 : 04:00
    ['Pacific/Kiritimati', '2026-10-24'], // UTC+14 : 12:30
  ])('%s → %s', (zone, expected) => {
    expect(localDateOf(instant, zone)).toBe(expected);
  });

  it('bascule exactement à minuit local', () => {
    expect(localDateOf(at('2026-10-23T21:59:59Z'), 'Europe/Paris')).toBe(
      '2026-10-23',
    );
    expect(localDateOf(at('2026-10-23T22:00:00Z'), 'Europe/Paris')).toBe(
      '2026-10-24',
    );
  });
});

describe('nextLocalMidnight', () => {
  it.each([
    [
      'jour normal à Paris',
      '2026-10-23T10:00:00Z',
      'Europe/Paris',
      '2026-10-23T22:00:00.000Z',
    ],
    [
      'fuseau à demi-heure (Inde)',
      '2026-10-23T10:00:00Z',
      'Asia/Kolkata',
      '2026-10-23T18:30:00.000Z',
    ],
    ['UTC', '2026-10-23T10:00:00Z', 'UTC', '2026-10-24T00:00:00.000Z'],
    // Le 25/10/2026 dure 25 h à Paris (retour à l'heure d'hiver) : minuit suivant à 23:00 UTC.
    [
      'jour de 25 h (fin d’heure d’été, Paris)',
      '2026-10-25T00:00:00Z',
      'Europe/Paris',
      '2026-10-25T23:00:00.000Z',
    ],
    // Le 29/03/2026 dure 23 h à Paris (passage à l'heure d'été) : minuit suivant à 22:00 UTC.
    [
      'jour de 23 h (début d’heure d’été, Paris)',
      '2026-03-29T05:00:00Z',
      'Europe/Paris',
      '2026-03-29T22:00:00.000Z',
    ],
    [
      'fin d’heure d’été à New York',
      '2026-11-01T12:00:00Z',
      'America/New_York',
      '2026-11-02T05:00:00.000Z',
    ],
    [
      'exactement à minuit local',
      '2026-10-23T22:00:00Z',
      'Europe/Paris',
      '2026-10-24T22:00:00.000Z',
    ],
  ])('%s', (_name, now, zone, expected) => {
    expect(nextLocalMidnight(at(now), zone).toISOString()).toBe(expected);
  });

  it.each([
    'UTC',
    'Europe/Paris',
    'Asia/Kolkata',
    'America/New_York',
    'Pacific/Auckland',
    'Pacific/Kiritimati',
  ])(
    '%s : toujours dans le futur, au premier instant du jour suivant',
    (zone) => {
      // Une année entière, un instant tous les 6 h 17 (décalé pour croiser les changements d'heure).
      for (
        let t = at('2026-01-01T00:00:00Z').getTime();
        t < at('2027-01-01T00:00:00Z').getTime();
        t += 6.3 * 3_600_000
      ) {
        const now = new Date(t);
        const next = nextLocalMidnight(now, zone);
        expect(next.getTime()).toBeGreaterThan(now.getTime());
        // Un instant avant : encore le jour courant ; à l'instant : le jour suivant.
        expect(localDateOf(new Date(next.getTime() - 1000), zone)).toBe(
          localDateOf(now, zone),
        );
        expect(localDateOf(next, zone)).not.toBe(localDateOf(now, zone));
      }
    },
  );
});
