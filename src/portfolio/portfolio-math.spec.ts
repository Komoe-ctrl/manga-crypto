import { Prisma } from '../generated/prisma/client.js';
import {
  InsufficientQuantityError,
  applyBuy,
  applySell,
  valuePortfolio,
} from './portfolio-math.js';

const D = (value: string | number) => new Prisma.Decimal(value);
const position = (quantity: string, avgBuyPrice: string) => ({
  quantity: D(quantity),
  avgBuyPrice: D(avgBuyPrice),
});

describe('portfolio-math', () => {
  describe('applyBuy', () => {
    it("prend le prix d'achat comme prix moyen sans position existante", () => {
      const result = applyBuy(null, D('1'), D('100'));
      expect(result.quantity.toFixed()).toBe('1');
      expect(result.avgBuyPrice.toFixed()).toBe('100');
    });

    it('calcule le prix moyen pondéré', () => {
      const result = applyBuy(position('1', '100'), D('3'), D('200'));
      expect(result.quantity.toFixed()).toBe('4');
      expect(result.avgBuyPrice.toFixed()).toBe('175');
    });

    it('arrondit le prix moyen à 8 décimales', () => {
      const result = applyBuy(position('1', '100'), D('2'), D('101'));
      expect(result.avgBuyPrice.toFixed()).toBe('100.66666667');
    });

    it('reste exact sur les petites quantités (pas de flottant)', () => {
      const result = applyBuy(position('0.1', '1'), D('0.2'), D('1'));
      expect(result.quantity.toFixed()).toBe('0.3');
    });
  });

  describe('applySell', () => {
    it('garde le prix moyen et calcule le gain réalisé', () => {
      const { position: rest, realizedPnl } = applySell(
        position('2', '100'),
        D('1'),
        D('150'),
      );
      expect(rest?.quantity.toFixed()).toBe('1');
      expect(rest?.avgBuyPrice.toFixed()).toBe('100');
      expect(realizedPnl.toFixed()).toBe('50');
    });

    it('calcule une perte réalisée négative', () => {
      const { realizedPnl } = applySell(position('2', '100'), D('2'), D('80'));
      expect(realizedPnl.toFixed()).toBe('-40');
    });

    it('solde la position quand tout est vendu', () => {
      expect(
        applySell(position('2', '100'), D('2'), D('100')).position,
      ).toBeNull();
    });

    it('refuse de vendre plus que détenu ou sans position', () => {
      expect(() =>
        applySell(position('1', '100'), D('1.0001'), D('1')),
      ).toThrow(InsufficientQuantityError);
      expect(() => applySell(null, D('1'), D('1'))).toThrow(
        InsufficientQuantityError,
      );
    });
  });

  describe('valuePortfolio', () => {
    it('calcule valeur, P&L et poids', () => {
      const v = valuePortfolio([
        { symbol: 'BTC', ...position('0.5', '60000'), price: D('70000') },
        { symbol: 'ETH', ...position('10', '2000'), price: D('3000') },
      ]);

      expect(v.totalValue.toFixed()).toBe('65000');
      expect(v.totalCost.toFixed()).toBe('50000');
      expect(v.totalPnl.toFixed()).toBe('15000');
      expect(v.totalPnlPct?.toFixed()).toBe('30');
      expect(v.complete).toBe(true);

      const [btc, eth] = v.assets;
      expect(btc.value?.toFixed()).toBe('35000');
      expect(btc.pnl?.toFixed()).toBe('5000');
      expect(btc.pnlPct?.toFixed()).toBe('16.67');
      expect(btc.weightPct?.toFixed()).toBe('53.85');
      expect(eth.weightPct?.toFixed()).toBe('46.15');
    });

    it('exclut des totaux une position sans prix et signale le total partiel', () => {
      const v = valuePortfolio([
        { symbol: 'BTC', ...position('1', '100'), price: D('150') },
        { symbol: 'XYZ', ...position('5', '10'), price: null },
      ]);

      expect(v.complete).toBe(false);
      expect(v.totalValue.toFixed()).toBe('150');
      expect(v.totalCost.toFixed()).toBe('100');
      expect(v.assets[1]).toMatchObject({
        currentPrice: null,
        value: null,
        pnl: null,
        weightPct: null,
      });
      expect(v.assets[1].costBasis.toFixed()).toBe('50');
      expect(v.assets[0].weightPct?.toFixed()).toBe('100');
    });

    it('gère un portefeuille vide', () => {
      const v = valuePortfolio([]);
      expect(v.totalValue.toFixed()).toBe('0');
      expect(v.totalPnlPct).toBeNull();
      expect(v.complete).toBe(true);
    });
  });
});
