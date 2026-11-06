import { Prisma } from '../../generated/prisma/client.js';
import { FallbackPriceProvider } from './fallback-price.provider.js';
import { PriceProvider, PriceUnavailableError } from './price-provider.js';

const D = (value: string) => new Prisma.Decimal(value);

type Prices = Map<string, Prisma.Decimal | null>;

function fake(over: Partial<PriceProvider> = {}) {
  return {
    getPrices: vi.fn(async (symbols: string[]): Promise<Prices> => {
      return new Map(symbols.map((s) => [s, null]));
    }),
    getPriceAt: vi.fn(async () => null),
    getHourlyCloses: vi.fn(async () => null),
    ...over,
  } as unknown as PriceProvider & {
    getPrices: ReturnType<typeof vi.fn>;
    getPriceAt: ReturnType<typeof vi.fn>;
    getHourlyCloses: ReturnType<typeof vi.fn>;
  };
}

const down = () => Promise.reject(new PriceUnavailableError());

describe('FallbackPriceProvider', () => {
  describe('getPrices', () => {
    it('ne contacte pas la source suivante quand tout est connu', async () => {
      const first = fake({ getPrices: async () => new Map([['BTC', D('1')]]) });
      const second = fake();
      const prices = await new FallbackPriceProvider([first, second]).getPrices(
        ['BTC'],
      );
      expect(prices.get('BTC')?.toString()).toBe('1');
      expect(second.getPrices).not.toHaveBeenCalled();
    });

    it('demande à la source suivante seulement les symboles manquants', async () => {
      const first = fake({
        getPrices: async () =>
          new Map<string, Prisma.Decimal | null>([
            ['BTC', D('1')],
            ['NEW', null],
          ]),
      });
      const second = fake({
        getPrices: vi.fn(async () => new Map([['NEW', D('2')]])),
      });
      const prices = await new FallbackPriceProvider([first, second]).getPrices(
        ['BTC', 'NEW'],
      );
      expect(second.getPrices).toHaveBeenCalledWith(['NEW']);
      expect(prices.get('BTC')?.toString()).toBe('1');
      expect(prices.get('NEW')?.toString()).toBe('2');
    });

    it('bascule sur la source suivante quand la première est en panne', async () => {
      const first = fake({ getPrices: down });
      const second = fake({
        getPrices: async () => new Map([['BTC', D('3')]]),
      });
      const prices = await new FallbackPriceProvider([first, second]).getPrices(
        ['BTC'],
      );
      expect(prices.get('BTC')?.toString()).toBe('3');
    });

    it('lève PriceUnavailableError quand toutes les sources sont en panne', async () => {
      const provider = new FallbackPriceProvider([
        fake({ getPrices: down }),
        fake({ getPrices: down }),
      ]);
      await expect(provider.getPrices(['BTC'])).rejects.toThrow(
        PriceUnavailableError,
      );
    });

    it('rend null (pas une erreur) pour un symbole connu de personne', async () => {
      const prices = await new FallbackPriceProvider([
        fake(),
        fake(),
      ]).getPrices(['ZZZZ']);
      expect(prices.get('ZZZZ')).toBeNull();
    });

    it('ne masque pas une erreur de programmation', async () => {
      const provider = new FallbackPriceProvider([
        fake({ getPrices: () => Promise.reject(new TypeError('bug')) }),
        fake(),
      ]);
      await expect(provider.getPrices(['BTC'])).rejects.toThrow(TypeError);
    });
  });

  describe('séries et prix passés', () => {
    it('prend la première série non nulle', async () => {
      const provider = new FallbackPriceProvider([
        fake({ getHourlyCloses: async () => null }),
        fake({ getHourlyCloses: async () => [D('1'), D('2')] }),
      ]);
      await expect(provider.getHourlyCloses('BTC', 2)).resolves.toHaveLength(2);
    });

    it('passe à la source suivante quand la première est en panne', async () => {
      const provider = new FallbackPriceProvider([
        fake({ getPriceAt: down }),
        fake({ getPriceAt: async () => D('7') }),
      ]);
      const price = await provider.getPriceAt('BTC', new Date());
      expect(price?.toString()).toBe('7');
    });

    it('rend null si une source a répondu « inconnu » et l’autre est en panne', async () => {
      const provider = new FallbackPriceProvider([
        fake({ getHourlyCloses: down }),
        fake({ getHourlyCloses: async () => null }),
      ]);
      await expect(provider.getHourlyCloses('NEW', 24)).resolves.toBeNull();
    });

    it('lève PriceUnavailableError quand aucune source n’a répondu', async () => {
      const provider = new FallbackPriceProvider([
        fake({ getHourlyCloses: down }),
        fake({ getHourlyCloses: down }),
      ]);
      await expect(provider.getHourlyCloses('BTC', 24)).rejects.toThrow(
        PriceUnavailableError,
      );
    });
  });
});
