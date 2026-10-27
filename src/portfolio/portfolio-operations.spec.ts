import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { OperationSource } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { FakePrisma } from '../../test/support/fake-prisma.js';
import { TransactionSide } from './dto/portfolio.dto.js';
import { PortfolioService } from './portfolio.service.js';

const build = () => {
  const prisma = new FakePrisma();
  const asPrisma = prisma as unknown as PrismaService;
  return {
    prisma,
    portfolio: new PortfolioService(asPrisma, new AuditService(asPrisma)),
  };
};
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
const list = (
  portfolio: PortfolioService,
  options: { symbol?: string; limit?: number; before?: Date } = {},
  userId = 'u1',
) => portfolio.listOperations(userId, { limit: 30, ...options });

describe('Journal des opérations du portefeuille', () => {
  describe('ce qui est enregistré', () => {
    it('un achat : nature, actif, quantité et prix exacts, déclaré, sans résultat réalisé', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '0.5', '60000'), {});

      const { items } = await list(portfolio);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        symbol: 'BTC',
        kind: 'BUY',
        source: 'DECLARED',
        quantity: '0.5',
        price: '60000',
        realizedPnl: null,
        orderId: null,
      });
      expect(items[0].createdAt).toBeInstanceOf(Date);
    });

    it('une vente : le résultat réalisé exact, y compris une perte', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '2', '100'), {});
      await portfolio.recordTransaction('u1', sell('BTC', '1', '150'), {});
      await portfolio.recordTransaction('u1', sell('BTC', '1', '90'), {});

      const { items } = await list(portfolio);
      expect(items.map((i) => [i.kind, i.realizedPnl])).toEqual([
        ['SELL', '-10'], // la plus récente d'abord
        ['SELL', '50'],
        ['BUY', null],
      ]);
    });

    it('une correction (SET) garde la nouvelle quantité et le nouveau prix moyen ; un retrait (REMOVE) garde ce qui a été retiré', async () => {
      const { portfolio } = build();
      await portfolio.setAsset(
        'u1',
        'ETH',
        { quantity: '1.2', avgBuyPrice: '2500' },
        {},
      );
      await portfolio.removeAsset('u1', 'ETH', {});

      const { items } = await list(portfolio);
      expect(items[0]).toMatchObject({
        kind: 'REMOVE',
        quantity: '1.2',
        price: '2500',
      });
      expect(items[1]).toMatchObject({
        kind: 'SET',
        quantity: '1.2',
        price: '2500',
        realizedPnl: null,
      });
    });

    it('garde les 18 décimales d’une quantité', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction(
        'u1',
        buy('ETH', '0.123456789012345678', '2300.5'),
        {},
      );
      expect((await list(portfolio)).items[0].quantity).toBe(
        '0.123456789012345678',
      );
    });

    it('une opération refusée ne laisse aucune trace dans le journal', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
      await expect(
        portfolio.recordTransaction('u1', sell('BTC', '9', '100'), {}),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(portfolio.removeAsset('u1', 'SOL', {})).rejects.toThrow();

      const { items } = await list(portfolio);
      expect(items).toHaveLength(1); // seul l'achat initial
    });
  });

  describe('gain réalisé cumulé', () => {
    it('somme exacte en décimaux (0,1 + 0,2 = 0,3, pas 0,30000000000000004)', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '10', '100'), {});
      await portfolio.recordTransaction('u1', sell('BTC', '1', '100.1'), {});
      await portfolio.recordTransaction('u1', sell('BTC', '1', '100.2'), {});

      expect((await list(portfolio)).realizedTotal).toBe('0.3');
    });

    it('cumule tous les actifs, ou un seul si on le demande', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '2', '100'), {});
      await portfolio.recordTransaction('u1', sell('BTC', '1', '150'), {}); // +50
      await portfolio.recordTransaction('u1', buy('ETH', '4', '10'), {});
      await portfolio.recordTransaction('u1', sell('ETH', '2', '5'), {}); // −10

      expect((await list(portfolio)).realizedTotal).toBe('40');
      expect((await list(portfolio, { symbol: 'BTC' })).realizedTotal).toBe(
        '50',
      );
      expect((await list(portfolio, { symbol: 'ETH' })).realizedTotal).toBe(
        '-10',
      );
      expect((await list(portfolio, { symbol: 'SOL' })).realizedTotal).toBe(
        '0',
      );
    });

    it('sans aucune vente : « 0 », pas null ni NaN', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
      expect((await list(portfolio)).realizedTotal).toBe('0');
    });

    it('ne dépend pas de la page lue', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '10', '100'), {});
      for (let i = 0; i < 4; i++) {
        await portfolio.recordTransaction('u1', sell('BTC', '1', '110'), {}); // +10 chacune
      }
      const page = await list(portfolio, { limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.realizedTotal).toBe('40');
    });
  });

  describe('lecture', () => {
    it('filtre par actif', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
      await portfolio.recordTransaction('u1', buy('ETH', '1', '10'), {});
      const { items } = await list(portfolio, { symbol: 'ETH' });
      expect(items.map((i) => i.symbol)).toEqual(['ETH']);
    });

    it('pagine : la limite, puis « avant » la dernière date lue, sans doublon ni trou', async () => {
      const { portfolio } = build();
      for (const q of ['1', '2', '3', '4', '5']) {
        await portfolio.recordTransaction('u1', buy('BTC', q, '100'), {});
      }
      const first = await list(portfolio, { limit: 2 });
      expect(first.items.map((i) => i.quantity)).toEqual(['5', '4']);
      const second = await list(portfolio, {
        limit: 2,
        before: first.items.at(-1)!.createdAt,
      });
      expect(second.items.map((i) => i.quantity)).toEqual(['3', '2']);
      const last = await list(portfolio, {
        limit: 2,
        before: second.items.at(-1)!.createdAt,
      });
      expect(last.items.map((i) => i.quantity)).toEqual(['1']);
    });

    it('isole les utilisateurs', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '2', '100'), {});
      await portfolio.recordTransaction('u1', sell('BTC', '1', '150'), {});

      const other = await list(portfolio, {}, 'u2');
      expect(other.items).toEqual([]);
      expect(other.realizedTotal).toBe('0');
    });
  });

  describe('ordres exécutés', () => {
    it('une jambe en actif est visible avec son ordre ; la jambe en USDT est masquée de la liste', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('USDT', '1000', '1'), {});
      const order = { source: OperationSource.ORDER, orderId: 'o-1' };
      await portfolio.recordTransaction(
        'u1',
        buy('BTC', '0.01', '80000'),
        {},
        order,
      );
      await portfolio.recordTransaction(
        'u1',
        sell('USDT', '800', '1'),
        {},
        { ...order, cashLeg: true },
      );

      const { items } = await list(portfolio);
      expect(items.map((i) => [i.symbol, i.source, i.orderId])).toEqual([
        ['BTC', 'ORDER', 'o-1'],
        ['USDT', 'DECLARED', null],
      ]);
    });

    it('le gain d’une vente exécutée par un ordre compte dans le cumul', async () => {
      const { portfolio } = build();
      await portfolio.recordTransaction('u1', buy('BTC', '1', '100'), {});
      await portfolio.recordTransaction(
        'u1',
        sell('BTC', '1', '130'),
        {},
        { source: OperationSource.ORDER, orderId: 'o-2' },
      );
      expect((await list(portfolio)).realizedTotal).toBe('30');
    });
  });

  describe('si le journal est en panne', () => {
    it('l’opération de l’utilisateur n’est ni refusée ni défaite : la position est écrite, l’erreur est consignée', async () => {
      const { portfolio, prisma } = build();
      prisma.portfolioOperation.create = async () => {
        throw new Error('base indisponible');
      };
      const logged = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const result = await portfolio.recordTransaction(
        'u1',
        buy('BTC', '1', '100'),
        {},
      );

      expect(result.holding).toEqual({
        symbol: 'BTC',
        quantity: '1',
        avgBuyPrice: '100',
      });
      expect(prisma.assets).toHaveLength(1);
      expect(prisma.auditLogs.at(-1)).toMatchObject({
        action: 'portfolio.transaction_recorded',
      }); // le journal d'audit garde la trace complète
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toContain('BUY BTC');
      logged.mockRestore();
    });
  });
});
