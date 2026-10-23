import { Prisma } from '../../generated/prisma/client.js';
import { lossPct, openHoldingsValueNow, toSnapshot } from './daily-loss.js';

const D = (value: string | number) => new Prisma.Decimal(value);
const prices = (entries: Record<string, number | null>) =>
  new Map(
    Object.entries(entries).map(([k, v]) => [k, v === null ? null : D(v)]),
  );

describe('daily-loss', () => {
  describe('toSnapshot', () => {
    it("calcule la valeur d'ouverture et fige quantités et prix", () => {
      const snapshot = toSnapshot(
        [
          { symbol: 'BTC', quantity: D('0.5') },
          { symbol: 'ETH', quantity: D('10') },
        ],
        prices({ BTC: 70000, ETH: 3000 }),
      );
      expect(snapshot?.equity.toFixed()).toBe('65000');
      expect(snapshot?.holdings).toEqual([
        { symbol: 'BTC', quantity: '0.5', price: '70000' },
        { symbol: 'ETH', quantity: '10', price: '3000' },
      ]);
    });

    it('ne conclut pas si un prix manque', () => {
      expect(
        toSnapshot([{ symbol: 'XYZ', quantity: D(1) }], prices({ XYZ: null })),
      ).toBeNull();
      expect(
        toSnapshot([{ symbol: 'XYZ', quantity: D(1) }], new Map()),
      ).toBeNull();
    });
  });

  describe('openHoldingsValueNow', () => {
    const open = [
      { symbol: 'BTC', quantity: '0.5', price: '70000' },
      { symbol: 'ETH', quantity: '10', price: '3000' },
    ];

    it("valorise les quantités d'ouverture aux prix courants", () => {
      expect(
        openHoldingsValueNow(
          open,
          prices({ BTC: 60000, ETH: 3000 }),
        )?.toFixed(),
      ).toBe('60000');
    });

    it('renvoie null si un prix manque (pas de conclusion sur un total partiel)', () => {
      expect(
        openHoldingsValueNow(open, prices({ BTC: 60000, ETH: null })),
      ).toBeNull();
    });
  });

  describe('lossPct', () => {
    it('calcule la perte en % de la valeur d’ouverture', () => {
      expect(lossPct(D(10000), D(9700)).toFixed()).toBe('3');
      expect(lossPct(D(10000), D(9650)).toFixed()).toBe('3.5');
    });

    it('est négative en cas de gain', () => {
      expect(lossPct(D(10000), D(10100)).toFixed()).toBe('-1');
    });

    it("vaut 0 sans valeur d'ouverture positive", () => {
      expect(lossPct(D(0), D(100)).toFixed()).toBe('0');
    });
  });
});
