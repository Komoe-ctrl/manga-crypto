import { isInNightWindow } from './night-mode.js';

const at = (iso: string) => new Date(iso);
// Défaut : 22:00 (1320) → 07:00 (420), la plage passe minuit.
const night = (iso: string, zone = 'UTC', start = 1320, end = 420) =>
  isInNightWindow(at(iso), zone, start, end);

describe('isInNightWindow', () => {
  describe('plage qui passe minuit (22:00 → 07:00)', () => {
    it.each([
      ['21:59', false],
      ['22:00', true], // début inclus
      ['23:59', true],
      ['00:00', true],
      ['03:30', true],
      ['06:59', true],
      ['07:00', false], // fin exclue
      ['12:00', false],
    ])('%s UTC → %s', (time, expected) => {
      expect(night(`2026-10-23T${time}:00Z`)).toBe(expected);
    });
  });

  describe('plage dans la même journée (13:00 → 15:00)', () => {
    it.each([
      ['12:59', false],
      ['13:00', true],
      ['14:59', true],
      ['15:00', false],
      ['23:00', false],
    ])('%s → %s', (time, expected) => {
      expect(night(`2026-10-23T${time}:00Z`, 'UTC', 780, 900)).toBe(expected);
    });
  });

  it('début = fin : plage vide, jamais « nuit »', () => {
    expect(night('2026-10-23T03:00:00Z', 'UTC', 600, 600)).toBe(false);
    expect(night('2026-10-23T10:00:00Z', 'UTC', 0, 0)).toBe(false);
  });

  it('utilise le fuseau de l’utilisateur', () => {
    // 22:30 UTC = 00:30 à Paris (nuit) mais 15:30 à Los Angeles (jour).
    expect(night('2026-10-23T22:30:00Z', 'Europe/Paris')).toBe(true);
    expect(night('2026-10-23T22:30:00Z', 'America/Los_Angeles')).toBe(false);
    // Fuseau à demi-heure : 01:30 UTC = 07:00 à Kolkata → fin exclue.
    expect(night('2026-10-23T01:30:00Z', 'Asia/Kolkata')).toBe(false);
    expect(night('2026-10-23T01:29:00Z', 'Asia/Kolkata')).toBe(true);
  });

  it('suit le changement d’heure (Paris, retour à l’heure d’hiver le 25/10/2026)', () => {
    // Avant : UTC+2, 05:30 UTC = 07:30 Paris (jour). Après : UTC+1, 05:30 UTC = 06:30 Paris (nuit).
    expect(night('2026-10-24T05:30:00Z', 'Europe/Paris')).toBe(false);
    expect(night('2026-10-25T05:30:00Z', 'Europe/Paris')).toBe(true);
  });
});
