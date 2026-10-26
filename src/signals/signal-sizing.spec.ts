import { Prisma } from '../generated/prisma/client.js';
import { sizeBuy, type BuySizingInput } from './signal-sizing.js';

const input = (over: Partial<BuySizingInput> = {}): BuySizingInput => ({
  score: 0.8,
  minScore: 0.6,
  price: '100',
  capital: '10000',
  maxExposurePct: '5',
  heldQuantity: '0',
  ...over,
});

const quantity = (over: Partial<BuySizingInput> = {}) => {
  const sizing = sizeBuy(input(over));
  return 'quantity' in sizing ? sizing.quantity.toFixed() : sizing;
};

describe('sizeBuy', () => {
  it('achète la place disponible (5 % du capital) proportionnellement au score', () => {
    // Plafond : 5 % de 10 000 = 500 $, soit 5 unités à 100 $.
    expect(quantity({ score: 1 })).toBe('5');
    expect(quantity({ score: 0.8 })).toBe('4');
    expect(quantity({ score: 0.6 })).toBe('3');
  });

  it('retire la position déjà détenue de la place disponible', () => {
    // 2 unités détenues (200 $) : il reste 300 $ de place → 80 % = 240 $ = 2,4 unités.
    expect(quantity({ heldQuantity: '2' })).toBe('2.4');
    expect(quantity({ heldQuantity: '4.5', score: 1 })).toBe('0.5');
  });

  it('n’achète rien quand la position est au plafond ou au-dessus', () => {
    expect(quantity({ heldQuantity: '5' })).toEqual({ skip: 'no_capacity' });
    expect(quantity({ heldQuantity: '8' })).toEqual({ skip: 'no_capacity' });
  });

  it('suit le prix courant et le plafond d’exposition de l’utilisateur', () => {
    expect(
      quantity({
        price: '81700',
        capital: '10000',
        maxExposurePct: '5',
        score: 1,
      }),
    ).toBe('0.00611995');
    expect(quantity({ maxExposurePct: '10', score: 1 })).toBe('10');
    expect(quantity({ maxExposurePct: '0.01', score: 1 })).toBe('0.01');
  });

  describe('seuil de score', () => {
    it('ignore un score sous le seuil, l’accepte au seuil exact', () => {
      expect(quantity({ score: 0.59, minScore: 0.6 })).toEqual({
        skip: 'below_min_score',
      });
      expect(quantity({ score: 0.6, minScore: 0.6 })).toBe('3');
    });

    it('respecte un seuil personnalisé', () => {
      expect(quantity({ score: 0.8, minScore: 0.9 })).toEqual({
        skip: 'below_min_score',
      });
      expect(quantity({ score: 0.1, minScore: 0 })).toBe('0.5');
    });
  });

  describe('quantité minuscule', () => {
    it('refuse une quantité arrondie à zéro', () => {
      expect(quantity({ capital: '0.000001', price: '100000' })).toEqual({
        skip: 'too_small',
      });
    });

    it('arrondit à la baisse à 8 décimales', () => {
      // 500 $ / 3 $ = 166,666… : arrondi à la baisse, jamais au-dessus.
      expect(quantity({ price: '3', score: 1 })).toBe('166.66666666');
    });
  });

  it('ne dépasse jamais la place disponible, quel que soit l’arrondi (propriété sur des cas variés)', () => {
    const prices = [
      '0.00001234',
      '0.5',
      '3',
      '81700.5',
      '99999.99999999',
      '1234567',
    ];
    const capitals = ['1', '137.37', '10000', '9876543.21'];
    const scores = [0.6, 0.61, 0.777, 0.9, 0.9999, 1];
    for (const price of prices) {
      for (const capital of capitals) {
        for (const score of scores) {
          for (const held of ['0', '0.0001']) {
            const sizing = sizeBuy(
              input({ price, capital, score, heldQuantity: held }),
            );
            if (!('quantity' in sizing)) continue;
            const room = new Prisma.Decimal(capital)
              .mul('0.05')
              .minus(new Prisma.Decimal(held).mul(price));
            const spent = sizing.quantity.mul(price);
            expect(spent.lte(room.mul(score))).toBe(true);
            // Et l'exposition totale reste sous le plafond de l'utilisateur (le garde-fou des ordres le revérifie).
            expect(
              new Prisma.Decimal(held)
                .plus(sizing.quantity)
                .mul(price)
                .lte(new Prisma.Decimal(capital).mul('0.05')),
            ).toBe(true);
          }
        }
      }
    }
  });

  it('accepte des nombres, des chaînes et des Decimal', () => {
    const sizing = sizeBuy({
      score: 1,
      minScore: 0.6,
      price: new Prisma.Decimal(100),
      capital: 10000,
      maxExposurePct: new Prisma.Decimal('5'),
      heldQuantity: 0,
    });
    expect('quantity' in sizing && sizing.quantity.toFixed()).toBe('5');
  });
});
