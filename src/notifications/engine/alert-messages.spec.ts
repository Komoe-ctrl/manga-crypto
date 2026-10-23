import { Prisma } from '../../generated/prisma/client.js';
import { AlertCondition } from '../../generated/prisma/enums.js';
import { describeAlert, windowLabel } from './alert-messages.js';

const D = (value: string | number) => new Prisma.Decimal(value);
const alert = (over: Partial<Parameters<typeof describeAlert>[0]>) => ({
  condition: AlertCondition.PRICE_DROP_PCT,
  assetSymbol: 'BTC',
  threshold: D(5),
  windowMinutes: 60,
  ...over,
});

describe('windowLabel', () => {
  it.each([
    [5, '5 min'],
    [45, '45 min'],
    [60, '1 h'],
    [120, '2 h'],
    [1440, '24 h'],
    [2880, '2 jours'],
    [10080, '7 jours'],
    [90, '90 min'],
  ])('%i minutes → %s', (minutes, label) => {
    expect(windowLabel(minutes)).toBe(label);
  });
});

describe('describeAlert', () => {
  it('baisse sur une fenêtre (BTC −5 % en 1 h)', () => {
    expect(
      describeAlert(alert({}), { current: D(63000), past: D(66316.5) }),
    ).toEqual({
      title: 'BTC −5 % en 1 h',
      body: 'BTC a baissé de 5 % sur 1 h (prix actuel : 63 000 $).',
    });
  });

  it('hausse sur une fenêtre (SOL +8 % sur 24 h)', () => {
    const { title, body } = describeAlert(
      alert({
        condition: AlertCondition.PRICE_RISE_PCT,
        assetSymbol: 'SOL',
        threshold: D(8),
        windowMinutes: 1440,
      }),
      { current: D(180), past: D(160) },
    );
    expect(title).toBe('SOL +8 % sur 24 h');
    expect(body).toBe(
      'SOL a progressé de 12,5 % sur 24 h (prix actuel : 180 $).',
    );
  });

  it('franchissement à la hausse (ETH franchit 3 500 $)', () => {
    expect(
      describeAlert(
        alert({
          condition: AlertCondition.PRICE_CROSS_ABOVE,
          assetSymbol: 'ETH',
          threshold: D(3500),
          windowMinutes: null,
        }),
        { current: D('3512.4'), past: null },
      ),
    ).toEqual({
      title: 'ETH franchit 3 500 $ à la hausse',
      body: 'Prix actuel de ETH : 3 512,4 $ (seuil : 3 500 $).',
    });
  });

  it('franchissement à la baisse', () => {
    const { title } = describeAlert(
      alert({
        condition: AlertCondition.PRICE_CROSS_BELOW,
        assetSymbol: 'ETH',
        threshold: D(3000),
        windowMinutes: null,
      }),
      { current: D(2990), past: null },
    );
    expect(title).toBe('ETH passe sous 3 000 $');
  });

  it('baisse du portefeuille (−10 % sur 7 jours)', () => {
    expect(
      describeAlert(
        alert({
          condition: AlertCondition.PORTFOLIO_DROP_PCT,
          assetSymbol: null,
          threshold: D(10),
          windowMinutes: 10080,
        }),
        { current: D(8900), past: D(10000) },
      ),
    ).toEqual({
      title: 'Portefeuille −10 % sur 7 jours',
      body: 'La valeur de votre portefeuille a baissé de 11 % sur 7 jours (valeur actuelle : 8 900 $).',
    });
  });

  it('ne réduit jamais un petit seuil à zéro (0,0001 % ne devient pas « 0 % »)', () => {
    const { title, body } = describeAlert(
      alert({
        condition: AlertCondition.PRICE_RISE_PCT,
        threshold: D('0.0001'),
        windowMinutes: 60,
      }),
      { current: D('81610'), past: D('81560.5') },
    );
    expect(title).toBe('BTC +0,0001 % sur 1 h');
    expect(body).toContain('0,06069 %'); // variation réelle : 0,0607 %
  });

  it('affiche un petit prix avec ses chiffres significatifs', () => {
    const { title } = describeAlert(
      alert({
        condition: AlertCondition.PRICE_CROSS_BELOW,
        assetSymbol: 'PEPE',
        threshold: D('0.00001234'),
        windowMinutes: null,
      }),
      { current: D('0.0000121'), past: null },
    );
    expect(title).toBe('PEPE passe sous 0,00001234 $');
  });

  it("n'utilise que des espaces simples (messages Telegram, journaux)", () => {
    const { title, body } = describeAlert(
      alert({
        condition: AlertCondition.PRICE_CROSS_ABOVE,
        threshold: D(1234567),
        windowMinutes: null,
      }),
      { current: D(1234567), past: null },
    );
    expect(`${title}${body}`).not.toMatch(/[  ]/);
  });
});
