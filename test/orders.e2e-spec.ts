import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { PriceProvider } from '../src/portfolio/price/price-provider.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';

/** Parcours HTTP des ordres : base en mémoire, prix simulés, exécution dans la requête (jobs de fond désactivés). */
describe('Orders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: FakePrisma;
  const market: Record<string, number> = { BTC: 100, ETH: 3000, USDT: 1 };

  beforeEach(async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    prisma = new FakePrisma();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(PriceProvider)
      .useValue({
        getPrices: async (symbols: string[]) =>
          new Map(
            symbols.map((s) => [
              s,
              s in market ? new Prisma.Decimal(market[s]) : null,
            ]),
          ),
        getPriceAt: async () => null,
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(() => app.close());

  const http = () => request(app.getHttpServer());

  async function login(email = 'a@example.com') {
    const res = await http()
      .post('/api/auth/register')
      .send({ email, password: 'un-mot-de-passe-solide' })
      .expect(201);
    return `Bearer ${res.body.accessToken as string}`;
  }

  const fund = (auth: string, quantity = '10000') =>
    http()
      .put('/api/portfolio/assets/USDT')
      .set('Authorization', auth)
      .send({ quantity, avgBuyPrice: '1' })
      .expect(200);

  const order = (auth: string, body: object) =>
    http().post('/api/orders').set('Authorization', auth).send(body);

  it('exige une authentification', async () => {
    await http().get('/api/orders').expect(401);
    await http().post('/api/orders').send({}).expect(401);
    await http()
      .get('/api/orders/6f2b4d58-3c7f-4b6a-9d52-1c5d2b1f0a11')
      .expect(401);
    await http()
      .post('/api/orders/6f2b4d58-3c7f-4b6a-9d52-1c5d2b1f0a11/cancel')
      .expect(401);
  });

  it('passe un achat PAPER : exécuté, protégé par stop-loss et take-profit, portefeuille à jour', async () => {
    const auth = await login();
    await fund(auth);

    const res = await order(auth, {
      symbol: 'btc',
      side: 'BUY',
      quantity: '2',
    }).expect(201);
    expect(res.body).toMatchObject({
      status: 'FILLED',
      mode: 'PAPER',
      symbol: 'BTC/USDT',
      side: 'BUY',
      origin: 'MANUAL',
      quantity: '2',
      filledQuantity: '2',
      avgFillPrice: '100',
      fee: '0.2',
      feeCurrency: 'USDT',
      stopLossPrice: '97',
      takeProfitPrice: '106',
      failureReason: null,
    });
    expect(res.body.clientOrderId).toMatch(/^vl-[0-9a-f]{32}$/);

    const portfolio = await http()
      .get('/api/portfolio')
      .set('Authorization', auth)
      .expect(200);
    const held = Object.fromEntries(
      portfolio.body.assets.map((a: { symbol: string; quantity: string }) => [
        a.symbol,
        a.quantity,
      ]),
    );
    expect(held).toEqual({ BTC: '2', USDT: '9799.8' });
  });

  it('passe une vente PAPER', async () => {
    const auth = await login();
    await fund(auth);
    await http()
      .put('/api/portfolio/assets/BTC')
      .set('Authorization', auth)
      .send({ quantity: '3', avgBuyPrice: '80' })
      .expect(200);

    const res = await order(auth, {
      symbol: 'BTC',
      side: 'SELL',
      quantity: '1',
    }).expect(201);
    expect(res.body).toMatchObject({
      status: 'FILLED',
      side: 'SELL',
      stopLossPrice: null,
    });
  });

  describe('ordre refusé : 422 avec le motif, l’ordre est conservé', () => {
    it('exposition maximale dépassée', async () => {
      const auth = await login();
      await fund(auth); // plafond de 500 $ par position
      const res = await order(auth, {
        symbol: 'BTC',
        side: 'BUY',
        quantity: '6',
      }).expect(422);
      expect(res.body).toMatchObject({
        statusCode: 422,
        message: 'Exposition maximale par position dépassée',
        order: { status: 'REJECTED', failureReason: 'exposure_exceeded' },
      });

      const list = await http()
        .get('/api/orders')
        .set('Authorization', auth)
        .expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({
        status: 'REJECTED',
        failureReason: 'exposure_exceeded',
      });
    });

    it('kill switch actif', async () => {
      const auth = await login();
      await fund(auth);
      await http()
        .post('/api/risk/kill-switch/activate')
        .set('Authorization', auth)
        .expect(200);
      const res = await order(auth, {
        symbol: 'BTC',
        side: 'BUY',
        quantity: '1',
      }).expect(422);
      expect(res.body.order.failureReason).toBe('kill_switch');
    });

    it('vente supérieure à la quantité détenue, fonds insuffisants, stablecoin', async () => {
      const auth = await login();
      await fund(auth, '50');
      await http()
        .put('/api/portfolio/assets/ETH')
        .set('Authorization', auth)
        .send({ quantity: '10', avgBuyPrice: '3000' })
        .expect(200);

      expect(
        (
          await order(auth, {
            symbol: 'BTC',
            side: 'SELL',
            quantity: '1',
          }).expect(422)
        ).body.order.failureReason,
      ).toBe('insufficient_quantity');
      expect(
        (
          await order(auth, {
            symbol: 'BTC',
            side: 'BUY',
            quantity: '1',
          }).expect(422)
        ).body.order.failureReason,
      ).toBe('insufficient_funds');
      expect(
        (
          await order(auth, {
            symbol: 'USDT',
            side: 'BUY',
            quantity: '1',
          }).expect(422)
        ).body.order.failureReason,
      ).toBe('symbol_not_tradable');
    });

    it('ordre manuel en mode LIVE : réservé aux signaux', async () => {
      const auth = await login();
      await fund(auth);
      prisma.users[0].tradingMode = 'LIVE';
      const res = await order(auth, {
        symbol: 'BTC',
        side: 'BUY',
        quantity: '1',
      }).expect(422);
      expect(res.body.order).toMatchObject({
        status: 'REJECTED',
        failureReason: 'manual_orders_paper_only',
        mode: 'LIVE',
      });
      expect(prisma.tradeLogs).toHaveLength(1);
    });
  });

  it.each([
    [{ symbol: 'BTC', side: 'BUY', quantity: 1 }], // nombre JSON refusé
    [{ symbol: 'BTC', side: 'BUY', quantity: '0' }],
    [{ symbol: 'BTC', side: 'BUY', quantity: '-1' }],
    [{ symbol: 'BTC', side: 'BUY', quantity: '1e3' }],
    [{ symbol: 'BTC', side: 'BUY', quantity: '1.0000000000000000001' }],
    [{ symbol: 'BTC', side: 'HOLD', quantity: '1' }],
    [{ symbol: 'b t c', side: 'BUY', quantity: '1' }],
    [{ symbol: 'BTC', side: 'BUY', quantity: '1', price: '100' }], // champ inconnu (pas de prix imposé)
    [{ symbol: 'BTC', side: 'BUY', quantity: '1', mode: 'LIVE' }],
    [{ side: 'BUY', quantity: '1' }],
  ])('refuse une requête invalide %j', async (body) => {
    const auth = await login();
    await order(auth, body).expect(400);
    expect(prisma.tradeLogs).toHaveLength(0); // rien n'est enregistré
  });

  it('liste, lit et filtre', async () => {
    const auth = await login();
    await fund(auth);
    const first = (
      await order(auth, { symbol: 'BTC', side: 'BUY', quantity: '1' }).expect(
        201,
      )
    ).body;
    await order(auth, { symbol: 'BTC', side: 'BUY', quantity: '600' }).expect(
      422,
    );

    const list = await http()
      .get('/api/orders')
      .set('Authorization', auth)
      .expect(200);
    expect(list.body.items.map((o: { status: string }) => o.status)).toEqual([
      'REJECTED',
      'FILLED',
    ]);
    await http()
      .get('/api/orders?status=FILLED')
      .set('Authorization', auth)
      .expect((res) => expect(res.body.items).toHaveLength(1));
    await http()
      .get(`/api/orders/${first.id}`)
      .set('Authorization', auth)
      .expect(200)
      .expect((res) => expect(res.body.id).toBe(first.id));
  });

  it.each([
    ['limit=0'],
    ['limit=101'],
    ['limit=abc'],
    ['before=hier'],
    ['status=INCONNU'],
  ])('refuse la requête de liste invalide ?%s', async (query) => {
    const auth = await login();
    await http()
      .get(`/api/orders?${query}`)
      .set('Authorization', auth)
      .expect(400);
  });

  it('refuse d’annuler un ordre déjà exécuté (409)', async () => {
    const auth = await login();
    await fund(auth);
    const { id } = (
      await order(auth, { symbol: 'BTC', side: 'BUY', quantity: '1' }).expect(
        201,
      )
    ).body;
    await http()
      .post(`/api/orders/${id}/cancel`)
      .set('Authorization', auth)
      .expect(409);
  });

  it('isole les utilisateurs et refuse un identifiant invalide', async () => {
    const owner = await login('a@example.com');
    const other = await login('b@example.com');
    await fund(owner);
    const { id } = (
      await order(owner, { symbol: 'BTC', side: 'BUY', quantity: '1' }).expect(
        201,
      )
    ).body;

    await http()
      .get(`/api/orders/${id}`)
      .set('Authorization', other)
      .expect(404);
    await http()
      .post(`/api/orders/${id}/cancel`)
      .set('Authorization', other)
      .expect(404);
    await http()
      .get('/api/orders/pas-un-uuid')
      .set('Authorization', owner)
      .expect(400);
    await http()
      .get('/api/orders')
      .set('Authorization', other)
      .expect((res) => expect(res.body.items).toEqual([]));
  });

  it('limite le débit des ordres (10 par minute)', async () => {
    const auth = await login();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await order(auth, { symbol: 'BTC', side: 'SELL', quantity: '1' }))
          .status,
      );
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(422));
    expect(statuses[10]).toBe(429);
  });
});
