import { Prisma } from '../generated/prisma/client.js';
import { buildDigest, type DigestInput } from './digest-content.js';

const D = (value: string | number) => new Prisma.Decimal(value);

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  kind: 'TODAY',
  held: [],
  critical: [],
  portfolio: { valueNow: D(10120), valuePast: D(10000) },
  movers: [],
  ...over,
});

describe('buildDigest', () => {
  describe('rapport du matin (24 h)', () => {
    it('produit le texte calme de la maquette', () => {
      const { summary, points, portfolioDeltaPct } = buildDigest(
        input({
          held: ['ETH −1,1 % en 1 h', 'SOL +2 % sur 24 h'],
          movers: [
            { symbol: 'SOL', changePct: D('4.2') },
            { symbol: 'ETH', changePct: D('-1.1') },
            { symbol: 'BTC', changePct: D('0.3') },
          ],
        }),
      );

      expect(summary).toBe(
        "Nuit calme. Votre portefeuille a progressé d'environ 1,2 % sur 24 h. " +
          "Aucune alerte critique ne s'est déclenchée. " +
          '2 alertes non urgentes ont été regroupées dans ce rapport. Aucune action requise.',
      );
      expect(points).toEqual([
        'Valeur du portefeuille : 10 120 $',
        'Plus forte hausse : SOL +4,2 %',
        'Plus forte baisse : ETH −1,1 %',
        'Regroupée : ETH −1,1 % en 1 h',
        'Regroupée : SOL +2 % sur 24 h',
      ]);
      expect(portfolioDeltaPct?.toFixed()).toBe('1.2');
    });

    it('décrit une baisse, au singulier pour une seule alerte regroupée', () => {
      const { summary } = buildDigest(
        input({
          portfolio: { valueNow: D(9800), valuePast: D(10000) },
          held: ['x'],
        }),
      );
      expect(summary).toContain(
        "Votre portefeuille a reculé d'environ 2 % sur 24 h.",
      );
      expect(summary).toContain(
        'Une alerte non urgente a été regroupée dans ce rapport.',
      );
    });

    it('dit « stable » sous 0,1 %', () => {
      const { summary } = buildDigest(
        input({ portfolio: { valueNow: D(10005), valuePast: D(10000) } }),
      );
      expect(summary).toContain(
        'Votre portefeuille est resté stable sur 24 h.',
      );
      expect(summary).not.toContain("d'environ");
    });

    it('ne parle plus de « nuit calme » pour un mouvement de 3 % ou plus', () => {
      expect(
        buildDigest(
          input({ portfolio: { valueNow: D(10299), valuePast: D(10000) } }),
        ).summary,
      ).toMatch(/^Nuit calme\./);
      expect(
        buildDigest(
          input({ portfolio: { valueNow: D(10300), valuePast: D(10000) } }),
        ).summary,
      ).not.toMatch(/^Nuit calme\./);
      expect(
        buildDigest(
          input({ portfolio: { valueNow: D(9700), valuePast: D(10000) } }),
        ).summary,
      ).not.toMatch(/^Nuit calme\./);
    });

    it('signale les alertes critiques et invite à les consulter, sans « nuit calme »', () => {
      const one = buildDigest(
        input({ critical: ['Perte journalière maximale atteinte'] }),
      );
      expect(one.summary).not.toMatch(/^Nuit calme\./);
      expect(one.summary).toContain("Une alerte critique s'est déclenchée.");
      expect(one.summary).toMatch(/Consultez vos alertes critiques\.$/);
      expect(one.summary).not.toContain('Aucune action requise');
      expect(one.points).toContain(
        'Critique : Perte journalière maximale atteinte',
      );

      expect(
        buildDigest(input({ critical: ['a', 'b', 'c'] })).summary,
      ).toContain('3 alertes critiques se sont déclenchées.');
    });

    it('sans position : ne parle pas du portefeuille', () => {
      const { summary, points, portfolioDeltaPct } = buildDigest(
        input({ portfolio: null }),
      );
      expect(summary).toBe(
        "Nuit calme. Aucune alerte critique ne s'est déclenchée. Aucune action requise.",
      );
      expect(points).toEqual([]);
      expect(portfolioDeltaPct).toBeNull();
    });

    it('valeur non calculable (prix manquants) : le dit, sans inventer de chiffre', () => {
      const { summary, points, portfolioDeltaPct } = buildDigest(
        input({ portfolio: { valueNow: null, valuePast: null } }),
      );
      expect(summary).toContain(
        "La valeur du portefeuille n'a pas pu être calculée.",
      );
      expect(points.some((p) => p.startsWith('Valeur du portefeuille'))).toBe(
        false,
      );
      expect(portfolioDeltaPct).toBeNull();
    });

    it('valeur courante connue mais pas la valeur passée : pas de variation', () => {
      const { summary, portfolioDeltaPct } = buildDigest(
        input({ portfolio: { valueNow: D(10000), valuePast: null } }),
      );
      expect(summary).toContain("n'a pas pu être calculée");
      expect(portfolioDeltaPct).toBeNull();
    });

    it('valeur passée nulle : pas de variation (division par zéro évitée)', () => {
      expect(
        buildDigest(input({ portfolio: { valueNow: D(100), valuePast: D(0) } }))
          .portfolioDeltaPct,
      ).toBeNull();
    });

    it("n'affiche que les mouvements de bon signe (pas de « plus forte baisse » quand tout monte)", () => {
      const { points } = buildDigest(
        input({
          movers: [
            { symbol: 'SOL', changePct: D('4.2') },
            { symbol: 'ETH', changePct: D('1.1') },
          ],
        }),
      );
      expect(points).toContain('Plus forte hausse : SOL +4,2 %');
      expect(points.some((p) => p.startsWith('Plus forte baisse'))).toBe(false);
    });

    it('arrondit les mouvements comme la synthèse (2 décimales), sans effacer un mouvement minuscule', () => {
      const rounded = buildDigest(
        input({ movers: [{ symbol: 'BTC', changePct: D('-0.1199') }] }),
      );
      expect(rounded.points).toContain('Plus forte baisse : BTC −0,12 %');

      const tiny = buildDigest(
        input({ movers: [{ symbol: 'BTC', changePct: D('0.0004') }] }),
      );
      expect(tiny.points).toContain('Plus forte hausse : BTC +0,0004 %');
    });

    it('une seule position qui baisse : seulement la baisse', () => {
      const { points } = buildDigest(
        input({ movers: [{ symbol: 'ETH', changePct: D('-2.5') }] }),
      );
      expect(points).toContain('Plus forte baisse : ETH −2,5 %');
      expect(points.some((p) => p.startsWith('Plus forte hausse'))).toBe(false);
    });

    it('limite les listes et compte le reste', () => {
      const { points } = buildDigest(
        input({
          held: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'],
          critical: ['c1', 'c2', 'c3', 'c4', 'c5'],
        }),
      );
      expect(points.filter((p) => p.startsWith('Critique :'))).toHaveLength(3);
      expect(points).toContain('+ 2 autres alertes critiques');
      expect(points.filter((p) => p.startsWith('Regroupée :'))).toHaveLength(5);
      expect(points).toContain('+ 2 autres alertes regroupées');
    });

    it('accorde « 1 autre » au singulier', () => {
      const { points } = buildDigest(
        input({
          held: ['1', '2', '3', '4', '5', '6'],
          critical: ['1', '2', '3', '4'],
        }),
      );
      expect(points).toContain('+ 1 autre alerte critique');
      expect(points).toContain('+ 1 autre alerte regroupée');
    });
  });

  describe('rapport de la semaine (7 jours)', () => {
    const week = (over: Partial<DigestInput> = {}) =>
      buildDigest(input({ kind: 'WEEK', ...over }));

    it.each([
      [D(10480), 'Semaine positive.', 'a progressé'],
      [D(9850), 'Semaine difficile.', 'a reculé'],
      [D(10050), 'Semaine stable.', 'a progressé'],
    ])('valeur %s → %s', (valueNow, opening, verb) => {
      const { summary } = week({
        portfolio: { valueNow, valuePast: D(10000) },
      });
      expect(summary.startsWith(opening)).toBe(true);
      expect(summary).toContain(verb);
      expect(summary).toContain('sur 7 jours');
    });

    it('sans variation calculable : pas de qualificatif de semaine', () => {
      expect(week({ portfolio: null }).summary.startsWith('Semaine')).toBe(
        false,
      );
    });

    it('ne dit jamais « nuit calme »', () => {
      expect(week().summary).not.toContain('Nuit calme');
    });
  });
});
