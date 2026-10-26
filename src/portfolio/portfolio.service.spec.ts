import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import { AuditService } from '../audit/audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TransactionSide } from './dto/portfolio.dto.js';
import { PortfolioValuationService } from './portfolio-valuation.service.js';
import { PortfolioService } from './portfolio.service.js';
import {
  PriceProvider,
  PriceUnavailableError,
} from './price/price-provider.js';

const buy = (symbol: string, quantity: string, price: string) => ({
  symbol,
  side: TransactionSide.BUY,
  quantity,
  price,
});
const sell = (symbol: string, quantity: string, price: string) => ({
  symbol,
  side: TransactionSide.SELL,
  quantity,
  price,
});

function build(prices?: () => Promise<Map<string, Prisma.Decimal | null>>) {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  const portfolio = new PortfolioService(asPrisma, new AuditService(asPrisma));
  const provider = {
    getPrices: vi.fn(prices ?? (async () => new Map())),
    getHourlyCloses: vi.fn(async () => null),
    getPriceAt: vi.fn(async () => null),
  } satisfies PriceProvider;
  return {
    prisma,
    portfolio,
    provider,
    valuation: new PortfolioValuationService(portfolio, provider),
  };
}

describe('PortfolioService', () => {
  describe('transactions', () => {
    it('crée une position avec un premier achat', async () => {
      const { portfolio, prisma } = build();
      const result = await portfolio.recordTransaction(
        'u1',
        buy('BTC', '0.5', '60000'),
        {},
      );
      expect(result).toEqual({
        holding: { symbol: 'BTC', quantity: '0.5', avgBuyPrice: '60000' },
        realizedPnl: null,
      });
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'portfolio.transaction_recorded',
        metadata: {
          symbol: 'BTC',
          side: 'BUY',
          quantity: '0.5',
          price: '60000',
        },
      });
    });

    it('moyenne le prix sur un second achat', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
      const result = await portfolio.recordTransaction(
        'u1',
        buy('BTC', '3', '200'),
        {},
      );
      expect(result.holding).toEqual({
        symbol: 'BTC',
        quantity: '4',
        avgBuyPrice: '175',
      });
    });

    it('vend avec gain réalisé, sans changer le prix moyen', async () => {
      const { portfolio, prisma } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '2', '100'), {});
      const result = await portfolio.recordTransaction(
        'u1',
        sell('BTC', '1', '150'),
        {},
      );
      expect(result.realizedPnl).toBe('50');
      expect(result.holding).toEqual({
        symbol: 'BTC',
        quantity: '1',
        avgBuyPrice: '100',
      });
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        metadata: { realizedPnl: '50' },
      });
    });

    it('supprime la position quand tout est vendu', async () => {
      const { portfolio, prisma } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
      const result = await portfolio.recordTransaction(
        'u1',
        sell('BTC', '1', '90'),
        {},
      );
      expect(result.holding).toBeNull();
      expect(result.realizedPnl).toBe('-10');
      expect(prisma.assets).toHaveLength(0);
    });

    it('refuse une vente supérieure à la quantité détenue, sans rien modifier', async () => {
      const { portfolio, prisma } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
      await expect(
        portfolio.recordTransaction('u1', sell('BTC', '2', '100'), {}),
      ).rejects.toThrow(UnprocessableEntityException);
      await expect(
        portfolio.recordTransaction('u1', sell('ETH', '1', '100'), {}),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(prisma.assets[0].quantity.toFixed()).toBe('1');
    });

    it('garde la précision sur de très petites quantités (notation normale, jamais exponentielle)', async () => {
      const { portfolio } = build();
      const result = await portfolio.recordTransaction(
        'u1',
        buy('BTC', '0.00000001', '60000'),
        {},
      );
      expect(result.holding?.quantity).toBe('0.00000001');
    });

    it('isole les utilisateurs', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
      await expect(
        portfolio.recordTransaction('u2', sell('BTC', '1', '100'), {}),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(await portfolio.list('u2')).toEqual([]);
    });

    it('détecte une écriture simultanée (409) au lieu de perdre une mise à jour', async () => {
      const { portfolio, prisma } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});

      const results = await Promise.allSettled([
        portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {}),
        portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {}),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find((r) => r.status === 'rejected');
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.assets[0].quantity.toFixed()).toBe('2');
    });
  });

  describe('setAsset / removeAsset', () => {
    it('définit une position et audite l’ancienne valeur', async () => {
      const { portfolio, prisma } = build();
      await portfolio.setAsset(
        'u1',
        'BTC',
        { quantity: '1', avgBuyPrice: '100' },
        {},
      );
      const holding = await portfolio.setAsset(
        'u1',
        'BTC',
        { quantity: '2', avgBuyPrice: '110' },
        {},
      );
      expect(holding).toEqual({
        symbol: 'BTC',
        quantity: '2',
        avgBuyPrice: '110',
      });
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'portfolio.asset_set',
        metadata: {
          from: { quantity: '1', avgBuyPrice: '100' },
          to: { quantity: '2', avgBuyPrice: '110' },
        },
      });
    });

    it('supprime une position, 404 si elle n’existe pas', async () => {
      const { portfolio, prisma } = build();
      await portfolio.setAsset(
        'u1',
        'BTC',
        { quantity: '1', avgBuyPrice: '100' },
        {},
      );
      await portfolio.removeAsset('u1', 'BTC', {});
      expect(prisma.assets).toHaveLength(0);
      expect(prisma.auditLogs.at(-1)?.action).toBe('portfolio.asset_removed');
      await expect(portfolio.removeAsset('u1', 'BTC', {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

describe('PortfolioValuationService', () => {
  const prices = async () =>
    new Map<string, Prisma.Decimal | null>([
      ['BTC', new Prisma.Decimal(70000)],
      ['XYZ', null],
    ]);

  it('valorise en USD avec des chaînes décimales', async () => {
    const { portfolio, valuation } = build(prices);
    await portfolio.recordTransaction('u1', buy('BTC', '0.5', '60000'), {});
    const result = await valuation.valuate('u1');
    expect(result).toMatchObject({
      currency: 'USD',
      totalValue: '35000',
      totalCost: '30000',
      totalPnl: '5000',
      totalPnlPct: '16.67',
      complete: true,
    });
    expect(result.assets[0]).toMatchObject({
      symbol: 'BTC',
      currentPrice: '70000',
      weightPct: '100',
    });
  });

  it('dégrade sans échouer quand les prix sont indisponibles', async () => {
    const { portfolio, valuation } = build(async () => {
      throw new PriceUnavailableError();
    });
    await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
    const result = await valuation.valuate('u1');
    expect(result.complete).toBe(false);
    expect(result.assets[0]).toMatchObject({ currentPrice: null, value: null });
    await expect(valuation.totalValue('u1')).resolves.toBeNull();
  });

  it('signale une position sans prix', async () => {
    const { portfolio, valuation } = build(prices);
    await portfolio.recordTransaction('u1', buy('XYZ', '1', '10'), {});
    expect((await valuation.valuate('u1')).complete).toBe(false);
  });

  it('expose la valeur totale quand tout est valorisé', async () => {
    const { portfolio, valuation } = build(prices);
    await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
    expect((await valuation.totalValue('u1'))?.toFixed()).toBe('70000');
  });

  it("n'appelle pas la source de prix pour un portefeuille vide", async () => {
    const { valuation, provider } = build(prices);
    expect((await valuation.valuate('u1')).assets).toEqual([]);
    expect(provider.getPrices).not.toHaveBeenCalled();
  });
});
