import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  MARKET_SOURCES,
  type MarketSource,
} from '../src/market/market-source.js';
import { PriceUnavailableError } from '../src/portfolio/price/price-provider.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';

/** Parcours HTTP des données de marché : sources simulées, reste de l'application réel. */
describe('Market (e2e)', () => {
  let app: INestApplication<App>;
  let down = false;

  beforeEach(async () => {
    down = false;
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    const source = {
      name: 'coingecko',
      coins: async (symbols: string[]) => {
        if (down) throw new PriceUnavailableError();
        return new Map(
          symbols
            .filter((s) => s === 'BTC')
            .map((s) => [
              s,
              {
                symbol: s,
                name: 'Bitcoin',
                priceUsd: new Prisma.Decimal('67250.12'),
                marketCapUsd: new Prisma.Decimal('1330000000000'),
                rank: 1,
                change24hPct: new Prisma.Decimal('-1.84'),
              },
            ]),
        );
      },
    } as unknown as MarketSource;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new FakePrisma())
      .overrideProvider(MARKET_SOURCES)
      .useValue([source])
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

  async function login() {
    const res = await http()
      .post('/api/auth/register')
      .send({ email: 'a@example.com', password: 'un-mot-de-passe-solide' })
      .expect(201);
    return `Bearer ${res.body.accessToken as string}`;
  }

  it('exige une authentification', async () => {
    await http().get('/api/market/coins?symbols=BTC').expect(401);
  });

  it('renvoie les données de marché, les montants en texte, et les symboles inconnus', async () => {
    const auth = await login();
    const res = await http()
      .get('/api/market/coins?symbols=btc,zzzz')
      .set('Authorization', auth)
      .expect(200);
    expect(res.body).toEqual({
      coins: [
        {
          symbol: 'BTC',
          name: 'Bitcoin',
          priceUsd: '67250.12',
          marketCapUsd: '1330000000000',
          rank: 1,
          change24hPct: '-1.84',
          source: 'coingecko',
        },
      ],
      unknown: ['ZZZZ'],
      complete: true,
    });
  });

  it('refuse une liste de symboles absente ou invalide', async () => {
    const auth = await login();
    await http()
      .get('/api/market/coins')
      .set('Authorization', auth)
      .expect(400);
    await http()
      .get('/api/market/coins?symbols=BTC,é!')
      .set('Authorization', auth)
      .expect(400);
  });

  it('répond 503 quand aucune source ne répond', async () => {
    const auth = await login();
    down = true;
    await http()
      .get('/api/market/coins?symbols=BTC')
      .set('Authorization', auth)
      .expect(503);
  });
});
