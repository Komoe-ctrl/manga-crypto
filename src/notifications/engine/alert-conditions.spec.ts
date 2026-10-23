import { AlertCondition } from '../../generated/prisma/enums.js';
import { changePct, conditionMet } from './alert-conditions.js';

const {
  PRICE_CROSS_ABOVE,
  PRICE_CROSS_BELOW,
  PRICE_DROP_PCT,
  PRICE_RISE_PCT,
  PORTFOLIO_DROP_PCT,
} = AlertCondition;

describe('changePct', () => {
  it('calcule la variation en % (positive à la hausse)', () => {
    expect(changePct('105', '100')?.toFixed()).toBe('5');
    expect(changePct('95', '100')?.toFixed()).toBe('-5');
  });

  it('ne calcule rien sans valeur de départ positive', () => {
    expect(changePct('100', '0')).toBeNull();
    expect(changePct('100', '-5')).toBeNull();
  });
});

describe('conditionMet', () => {
  describe('franchissement de prix', () => {
    it('à la hausse : seuil atteint = remplie', () => {
      expect(
        conditionMet(PRICE_CROSS_ABOVE, '3500', {
          current: '3499.99',
          past: null,
        }),
      ).toBe(false);
      expect(
        conditionMet(PRICE_CROSS_ABOVE, '3500', {
          current: '3500',
          past: null,
        }),
      ).toBe(true);
      expect(
        conditionMet(PRICE_CROSS_ABOVE, '3500', {
          current: '3600',
          past: null,
        }),
      ).toBe(true);
    });

    it('à la baisse : seuil atteint = remplie', () => {
      expect(
        conditionMet(PRICE_CROSS_BELOW, '3000', {
          current: '3000.01',
          past: null,
        }),
      ).toBe(false);
      expect(
        conditionMet(PRICE_CROSS_BELOW, '3000', {
          current: '3000',
          past: null,
        }),
      ).toBe(true);
      expect(
        conditionMet(PRICE_CROSS_BELOW, '3000', {
          current: '2900',
          past: null,
        }),
      ).toBe(true);
    });
  });

  describe('variations sur une fenêtre', () => {
    it('baisse de 5 % : −5 % exactement déclenche, −4,99 % non', () => {
      expect(
        conditionMet(PRICE_DROP_PCT, '5', { current: '95', past: '100' }),
      ).toBe(true);
      expect(
        conditionMet(PRICE_DROP_PCT, '5', { current: '95.01', past: '100' }),
      ).toBe(false);
      expect(
        conditionMet(PRICE_DROP_PCT, '5', { current: '90', past: '100' }),
      ).toBe(true);
    });

    it('une hausse ne déclenche pas une alerte de baisse, et inversement', () => {
      expect(
        conditionMet(PRICE_DROP_PCT, '5', { current: '120', past: '100' }),
      ).toBe(false);
      expect(
        conditionMet(PRICE_RISE_PCT, '8', { current: '80', past: '100' }),
      ).toBe(false);
    });

    it('hausse de 8 % : +8 % exactement déclenche', () => {
      expect(
        conditionMet(PRICE_RISE_PCT, '8', { current: '108', past: '100' }),
      ).toBe(true);
      expect(
        conditionMet(PRICE_RISE_PCT, '8', { current: '107.99', past: '100' }),
      ).toBe(false);
    });

    it('baisse du portefeuille de 10 %', () => {
      expect(
        conditionMet(PORTFOLIO_DROP_PCT, '10', {
          current: '9000',
          past: '10000',
        }),
      ).toBe(true);
      expect(
        conditionMet(PORTFOLIO_DROP_PCT, '10', {
          current: '9001',
          past: '10000',
        }),
      ).toBe(false);
    });

    it('reste exact sur de petits prix (pas de flottant)', () => {
      // −5 % de 0,00001234 = 0,000011723 : atteint exactement.
      expect(
        conditionMet(PRICE_DROP_PCT, '5', {
          current: '0.000011723',
          past: '0.00001234',
        }),
      ).toBe(true);
    });
  });

  describe('données manquantes : on ne conclut pas', () => {
    it.each([
      PRICE_CROSS_ABOVE,
      PRICE_CROSS_BELOW,
      PRICE_DROP_PCT,
      PRICE_RISE_PCT,
      PORTFOLIO_DROP_PCT,
    ])('%s sans prix courant → null', (condition) => {
      expect(
        conditionMet(condition, '5', { current: null, past: '100' }),
      ).toBeNull();
    });

    it.each([PRICE_DROP_PCT, PRICE_RISE_PCT, PORTFOLIO_DROP_PCT])(
      '%s sans prix passé → null',
      (condition) => {
        expect(
          conditionMet(condition, '5', { current: '100', past: null }),
        ).toBeNull();
      },
    );

    it('une variation avec un prix passé nul ou négatif → null', () => {
      expect(
        conditionMet(PRICE_DROP_PCT, '5', { current: '100', past: '0' }),
      ).toBeNull();
    });
  });
});
