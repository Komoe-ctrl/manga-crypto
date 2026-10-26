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

/** Parcours HTTP du portefeuille : base en mémoire et prix simulés, reste de l'application réel. */
describe('Portfolio (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new FakePrisma())
      .overrideProvider(PriceProvider)
      .useValue({
        getPrices: async (symbols: string[]) =>
          new Map(
            symbols.map((s) => [
              s,
              s === 'BTC' ? new Prisma.Decimal(70000) : null,
            ]),
          ),
        // 168 clôtures horaires de 100 à 110 pour le BTC ; les autres actifs sont inconnus de la source.
        getHourlyCloses: async (symbol: string) =>
          symbol === 'BTC'
            ? Array.from(
                { length: 168 },
                (_, i) => new Prisma.Decimal(100 + (10 * i) / 167),
              )
            : null,
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

  it('exige une authentification', async () => {
    await http().get('/api/portfolio').expect(401);
    await http().post('/api/portfolio/transactions').send({}).expect(401);
  });

  it('enregistre des transactions puis valorise le portefeuille', async () => {
    const auth = await login();

    await http()
      .post('/api/portfolio/transactions')
      .set('Authorization', auth)
      .send({ symbol: 'btc', side: 'BUY', quantity: '0.5', price: '60000' })
      .expect(200)
      .expect({
        holding: { symbol: 'BTC', quantity: '0.5', avgBuyPrice: '60000' },
        realizedPnl: null,
      });

    const res = await http()
      .get('/api/portfolio')
      .set('Authorization', auth)
      .expect(200);
    expect(res.body).toMatchObject({
      currency: 'USD',
      totalValue: '35000',
      totalPnl: '5000',
      complete: true,
    });
    expect(res.body.assets[0]).toMatchObject({
      symbol: 'BTC',
      currentPrice: '70000',
      pnlPct: '16.67',
    });
  });

  it('signale les positions sans prix (complete: false)', async () => {
    const auth = await login();
    await http()
      .put('/api/portfolio/assets/xyz')
      .set('Authorization', auth)
      .send({ quantity: '5', avgBuyPrice: '10' })
      .expect(200);
    const res = await http()
      .get('/api/portfolio')
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.complete).toBe(false);
    expect(res.body.assets[0]).toMatchObject({
      symbol: 'XYZ',
      currentPrice: null,
      value: null,
    });
  });

  it('refuse une vente supérieure à la quantité détenue', async () => {
    const auth = await login();
    await http()
      .post('/api/portfolio/transactions')
      .set('Authorization', auth)
      .send({ symbol: 'BTC', side: 'SELL', quantity: '1', price: '100' })
      .expect(422);
  });

  it.each([
    [{ quantity: 0.5 }],
    [{ quantity: '0' }],
    [{ quantity: '-1' }],
    [{ quantity: '1e3' }],
    [{ quantity: 'abc' }],
    [{ quantity: '1.0000000000000000001' }],
    [{ price: '0.00' }],
    [{ symbol: 'bt c' }],
    [{ symbol: 'A' }],
    [{ side: 'HOLD' }],
    [{ extra: 1 }],
  ])('refuse une transaction invalide %j', async (override) => {
    const auth = await login();
    await http()
      .post('/api/portfolio/transactions')
      .set('Authorization', auth)
      .send({
        symbol: 'BTC',
        side: 'BUY',
        quantity: '1',
        price: '100',
        ...override,
      })
      .expect(400);
  });

  it('définit, corrige et supprime une position', async () => {
    const auth = await login();
    const put = (body: object) =>
      http()
        .put('/api/portfolio/assets/BTC')
        .set('Authorization', auth)
        .send(body);

    await put({ quantity: '1', avgBuyPrice: '100' }).expect(200);
    await put({ quantity: '2', avgBuyPrice: '110' })
      .expect(200)
      .expect({ symbol: 'BTC', quantity: '2', avgBuyPrice: '110' });
    await put({ quantity: '0', avgBuyPrice: '110' }).expect(400);
    await http()
      .put('/api/portfolio/assets/b-t-c')
      .set('Authorization', auth)
      .send({ quantity: '1', avgBuyPrice: '1' })
      .expect(400);

    await http()
      .delete('/api/portfolio/assets/btc')
      .set('Authorization', auth)
      .expect(204);
    await http()
      .delete('/api/portfolio/assets/BTC')
      .set('Authorization', auth)
      .expect(404);
  });

  it('exige une authentification pour les tendances', async () => {
    await http().get('/api/portfolio/trends').expect(401);
  });

  it('donne variations, courbe et état du marché de ses actifs', async () => {
    const auth = await login();
    await http()
      .put('/api/portfolio/assets/BTC')
      .set('Authorization', auth)
      .send({ quantity: '1', avgBuyPrice: '100' })
      .expect(200);

    const res = await http()
      .get('/api/portfolio/trends')
      .set('Authorization', auth)
      .expect(200);

    expect(res.body.complete).toBe(true);
    expect(res.body.market.state).toBe('CALM');
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0]).toMatchObject({
      symbol: 'BTC',
      change7dPct: '10',
    });
    expect(res.body.assets[0].sparkline).toHaveLength(42);
    expect(typeof res.body.assets[0].sparkline[0]).toBe('string');
  });

  it('un actif inconnu de la source : réponse partielle, pas une erreur', async () => {
    const auth = await login();
    await http()
      .put('/api/portfolio/assets/XYZ')
      .set('Authorization', auth)
      .send({ quantity: '5', avgBuyPrice: '10' })
      .expect(200);

    const res = await http()
      .get('/api/portfolio/trends')
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.complete).toBe(false);
    expect(res.body.assets[0]).toEqual({
      symbol: 'XYZ',
      change24hPct: null,
      change7dPct: null,
      sparkline: [],
    });
    expect(res.body.market.state).toBe('CALM'); // le BTC, lui, est connu
  });

  it('isole les utilisateurs', async () => {
    const owner = await login('a@example.com');
    const other = await login('b@example.com');
    await http()
      .put('/api/portfolio/assets/BTC')
      .set('Authorization', owner)
      .send({ quantity: '1', avgBuyPrice: '100' })
      .expect(200);

    const res = await http()
      .get('/api/portfolio')
      .set('Authorization', other)
      .expect(200);
    expect(res.body.assets).toEqual([]);
    await http()
      .delete('/api/portfolio/assets/BTC')
      .set('Authorization', other)
      .expect(404);
  });
});
