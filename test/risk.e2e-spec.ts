import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';

const PASSWORD = 'un-mot-de-passe-solide';

/** Parcours HTTP du contrôle du robot : base en mémoire, reste de l'application réel. */
describe('Risk (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: FakePrisma;
  let auth: string;

  beforeEach(async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    prisma = new FakePrisma();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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

    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'a@example.com', password: PASSWORD })
      .expect(201);
    auth = `Bearer ${res.body.accessToken as string}`;
  });

  afterEach(() => app.close());

  const http = () => request(app.getHttpServer());

  it('exige une authentification', async () => {
    await http().get('/api/risk/settings').expect(401);
    await http().post('/api/risk/kill-switch/activate').expect(401);
    await http().post('/api/risk/mode/live').send({}).expect(401);
  });

  it('lit et modifie les réglages', async () => {
    await http()
      .get('/api/risk/settings')
      .set('Authorization', auth)
      .expect(200)
      .expect({
        maxExposurePct: 5,
        maxDailyLossPct: 3,
        defaultStopLossPct: 3,
        defaultTakeProfitPct: 6,
      });

    await http()
      .patch('/api/risk/settings')
      .set('Authorization', auth)
      .send({ maxExposurePct: 2.5 })
      .expect(200)
      .expect((res) => expect(res.body.maxExposurePct).toBe(2.5));
  });

  it.each([
    [{ maxExposurePct: 0 }],
    [{ maxExposurePct: 100.01 }],
    [{ maxDailyLossPct: -1 }],
    [{ defaultStopLossPct: 1.234 }],
    [{ defaultTakeProfitPct: 1000.01 }],
    [{ maxExposurePct: '5' }],
    [{ inconnu: 1 }],
  ])('refuse un réglage invalide %j', async (body) => {
    await http()
      .patch('/api/risk/settings')
      .set('Authorization', auth)
      .send(body)
      .expect(400);
  });

  it('active et désactive le kill switch', async () => {
    await http()
      .post('/api/risk/kill-switch/activate')
      .set('Authorization', auth)
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({
          killSwitchActive: true,
          canTrade: false,
        }),
      );
    await http()
      .get('/api/risk/status')
      .set('Authorization', auth)
      .expect((res) => expect(res.body.blockedReason).toBe('KILL_SWITCH'));
    await http()
      .post('/api/risk/kill-switch/deactivate')
      .set('Authorization', auth)
      .expect(200)
      .expect((res) => expect(res.body.canTrade).toBe(true));
  });

  it('exige mot de passe et phrase de confirmation pour passer en LIVE', async () => {
    const live = (body: object) =>
      http().post('/api/risk/mode/live').set('Authorization', auth).send(body);

    await live({ password: PASSWORD }).expect(400);
    await live({ password: PASSWORD, confirmation: 'oui' }).expect(400);
    await live({
      password: 'mauvais-mot-de-passe',
      confirmation: 'PASSER EN LIVE',
    }).expect(403);
    // Bon mot de passe, mais aucun échange vérifié.
    await live({ password: PASSWORD, confirmation: 'PASSER EN LIVE' }).expect(
      422,
    );

    prisma.exchangeConfigs.push({
      id: 'ex-1',
      userId: prisma.users[0].id,
      status: 'ACTIVE',
      sandbox: false,
      verifiedAt: new Date(),
    });
    await live({ password: PASSWORD, confirmation: 'PASSER EN LIVE' })
      .expect(200)
      .expect((res) => expect(res.body.tradingMode).toBe('LIVE'));

    await http()
      .post('/api/risk/mode/paper')
      .set('Authorization', auth)
      .expect(200)
      .expect((res) => expect(res.body.tradingMode).toBe('PAPER'));
  });

  it('ne renvoie jamais le mot de passe dans une erreur', async () => {
    const res = await http()
      .post('/api/risk/mode/live')
      .set('Authorization', auth)
      .send({ password: PASSWORD, confirmation: 'non' })
      .expect(400);
    expect(res.text).not.toContain(PASSWORD);
  });
});
