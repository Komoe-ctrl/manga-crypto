import {
  dailyLossBreached,
  exceedsExposure,
  maxPositionValue,
  stopLossTakeProfit,
} from './risk-rules.js';

describe('risk-rules', () => {
  describe('exposition maximale', () => {
    it('calcule la valeur maximale engageable', () => {
      expect(maxPositionValue('10000', 5).toString()).toBe('500');
      expect(maxPositionValue('12345.67', '2.5').toString()).toBe('308.64175');
    });

    it("autorise l'égalité et refuse au-delà", () => {
      expect(exceedsExposure('500', '10000', 5)).toBe(false);
      expect(exceedsExposure('500.01', '10000', 5)).toBe(true);
    });

    it('interdit toute position sans capital', () => {
      expect(exceedsExposure('1', 0, 5)).toBe(true);
      expect(exceedsExposure('1', -100, 5)).toBe(true);
    });

    it("n'accumule aucune erreur de virgule flottante", () => {
      // 0.1 + 0.2 ≠ 0.3 en Float ; ici le calcul est exact.
      expect(exceedsExposure('0.3', '6', 5)).toBe(false);
      expect(maxPositionValue('0.3', 100).toString()).toBe('0.3');
    });
  });

  describe('stop-loss et take-profit', () => {
    it('achat : stop sous le prix, objectif au-dessus', () => {
      const { stopLoss, takeProfit } = stopLossTakeProfit('BUY', '100', 3, 6);
      expect(stopLoss.toString()).toBe('97');
      expect(takeProfit.toString()).toBe('106');
    });

    it('vente : inversé', () => {
      const { stopLoss, takeProfit } = stopLossTakeProfit('SELL', '100', 3, 6);
      expect(stopLoss.toString()).toBe('103');
      expect(takeProfit.toString()).toBe('94');
    });

    it('garde la précision sur de petits prix', () => {
      const { stopLoss } = stopLossTakeProfit('BUY', '0.00001234', 2.5, 5);
      expect(stopLoss.toString()).toBe('0.0000120315');
    });
  });

  describe('perte journalière', () => {
    it('se déclenche à la limite exacte et au-delà', () => {
      expect(dailyLossBreached('10000', '9700', 3)).toBe(true);
      expect(dailyLossBreached('10000', '9600', 3)).toBe(true);
    });

    it('ne se déclenche pas en dessous de la limite, ni sur un gain', () => {
      expect(dailyLossBreached('10000', '9700.01', 3)).toBe(false);
      expect(dailyLossBreached('10000', '10500', 3)).toBe(false);
    });

    it("ne calcule rien sans valeur d'ouverture positive", () => {
      expect(dailyLossBreached(0, 0, 3)).toBe(false);
      expect(dailyLossBreached(-5, -10, 3)).toBe(false);
    });
  });
});
