import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { BinanceVerifier } from '../src/exchanges/verification/binance.verifier.js';
import type { PermissionCheck } from '../src/exchanges/verification/exchange-verifier.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';

const body = {
  exchange: 'BINANCE',
  label: 'Principal',
  apiKey: 'public-key-a1b2',
  apiSecret: 'super-secret-value',
};

/** Parcours HTTP des clés d'échange : base en mémoire, plateforme simulée, reste de l'application réel. */
describe('Exchanges (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: FakePrisma;
  let check: PermissionCheck;

  beforeEach(async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    check = {
      permissions: ['read', 'trade'],
      withdrawalEnabled: false,
      verified: true,
    };
    prisma = new FakePrisma();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(BinanceVerifier)
      .useValue({ exchange: 'BINANCE', verify: async () => check })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
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

  async function login(email: string) {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'un-mot-de-passe-solide' })
      .expect(201);
    return `Bearer ${res.body.accessToken as string}`;
  }

  it('exige une authentification', async () => {
    await request(app.getHttpServer()).get('/api/exchanges').expect(401);
    await request(app.getHttpServer())
      .post('/api/exchanges')
      .send(body)
      .expect(401);
  });

  it('crée, liste et ne renvoie jamais la clé ni le secret', async () => {
    const auth = await login('a@example.com');
    const http = request(app.getHttpServer());

    const created = await http
      .post('/api/exchanges')
      .set('Authorization', auth)
      .send(body)
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'ACTIVE',
      permissions: ['read', 'trade'],
      apiKeyHint: 'a1b2',
    });
    expect(created.text).not.toContain(body.apiKey);
    expect(created.text).not.toContain(body.apiSecret);

    const listed = await http
      .get('/api/exchanges')
      .set('Authorization', auth)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.text).not.toContain(body.apiSecret);
    expect(JSON.stringify(prisma.exchangeConfigs)).not.toContain(
      body.apiSecret,
    );
  });

  it('refuse une clé avec le droit Withdrawal', async () => {
    const auth = await login('a@example.com');
    check = { ...check, withdrawalEnabled: true };
    const res = await request(app.getHttpServer())
      .post('/api/exchanges')
      .set('Authorization', auth)
      .send(body)
      .expect(422);
    expect(res.body.message).toMatch(/Withdrawal/);
    expect(prisma.exchangeConfigs).toHaveLength(0);
  });

  it('refuse une plateforme sans vérificateur', async () => {
    const auth = await login('a@example.com');
    await request(app.getHttpServer())
      .post('/api/exchanges')
      .set('Authorization', auth)
      .send({ ...body, exchange: 'KRAKEN' })
      .expect(422);
  });

  it('ne renvoie pas le secret dans une erreur de validation', async () => {
    const auth = await login('a@example.com');
    const res = await request(app.getHttpServer())
      .post('/api/exchanges')
      .set('Authorization', auth)
      .send({ ...body, label: '', role: 'admin' })
      .expect(400);
    expect(res.text).not.toContain(body.apiSecret);
    expect(res.text).not.toContain(body.apiKey);
  });

  it("isole les utilisateurs : l'id d'un autre donne 404, un id invalide 400", async () => {
    const owner = await login('a@example.com');
    const other = await login('b@example.com');
    const http = request(app.getHttpServer());
    const { id } = (
      await http
        .post('/api/exchanges')
        .set('Authorization', owner)
        .send(body)
        .expect(201)
    ).body;

    await http
      .post(`/api/exchanges/${id}/verify`)
      .set('Authorization', other)
      .expect(404);
    await http
      .delete(`/api/exchanges/${id}`)
      .set('Authorization', other)
      .expect(404);
    await http
      .get('/api/exchanges')
      .set('Authorization', other)
      .expect(200)
      .expect([]);
    await http
      .delete('/api/exchanges/pas-un-uuid')
      .set('Authorization', owner)
      .expect(400);
  });

  it('vérifie, désactive puis supprime', async () => {
    const auth = await login('a@example.com');
    const http = request(app.getHttpServer());
    const { id } = (
      await http
        .post('/api/exchanges')
        .set('Authorization', auth)
        .send(body)
        .expect(201)
    ).body;

    check = { ...check, withdrawalEnabled: true };
    await http
      .post(`/api/exchanges/${id}/verify`)
      .set('Authorization', auth)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('REJECTED'));

    await http
      .post(`/api/exchanges/${id}/disable`)
      .set('Authorization', auth)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('DISABLED'));

    await http
      .delete(`/api/exchanges/${id}`)
      .set('Authorization', auth)
      .expect(204);
    await http
      .get('/api/exchanges')
      .set('Authorization', auth)
      .expect(200)
      .expect([]);
  });
});
