import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';

/** Parcours HTTP de consultation des rapports du matin : base en mémoire, reste de l'application réel. */
describe('Digests (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: FakePrisma;

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
  });

  afterEach(() => app.close());

  const http = () => request(app.getHttpServer());

  async function login(email = 'a@example.com') {
    const res = await http()
      .post('/api/auth/register')
      .send({ email, password: 'un-mot-de-passe-solide' })
      .expect(201);
    return {
      auth: `Bearer ${res.body.accessToken as string}`,
      userId: res.body.user.id as string,
    };
  }

  const report = (userId: string, over: Record<string, unknown> = {}) =>
    prisma.digestReport.create({
      data: {
        userId,
        period: 'TODAY',
        periodStart: new Date(
          Date.UTC(2026, 9, 1 + prisma.digestReports.length),
        ),
        periodEnd: new Date(),
        summary: 'Nuit calme. Aucune action requise.',
        points: ['Valeur du portefeuille : 110 $'],
        portfolioDeltaPct: 1.2,
        queuedAlertsCount: 2,
        ...over,
      },
    });

  it('exige une authentification', async () => {
    await http().get('/api/digests').expect(401);
    await http()
      .get('/api/digests/6f2b4d58-3c7f-4b6a-9d52-1c5d2b1f0a11')
      .expect(401);
    await http()
      .post('/api/digests/6f2b4d58-3c7f-4b6a-9d52-1c5d2b1f0a11/read')
      .expect(401);
  });

  it('liste, lit et marque lu', async () => {
    const { auth, userId } = await login();
    await report(userId, { summary: 'hier' });
    const today = await report(userId, { summary: 'ce matin' });

    const list = await http()
      .get('/api/digests')
      .set('Authorization', auth)
      .expect(200);
    expect(list.body.unreadCount).toBe(2);
    expect(list.body.items.map((d: { summary: string }) => d.summary)).toEqual([
      'ce matin',
      'hier',
    ]);
    expect(list.body.items[0]).toMatchObject({
      period: 'TODAY',
      portfolioDeltaPct: '1.2',
      queuedAlertsCount: 2,
      readAt: null,
    });

    await http()
      .get(`/api/digests/${today.id}`)
      .set('Authorization', auth)
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({
          id: today.id,
          points: ['Valeur du portefeuille : 110 $'],
        }),
      );

    await http()
      .post(`/api/digests/${today.id}/read`)
      .set('Authorization', auth)
      .expect(200)
      .expect((res) => expect(res.body.readAt).not.toBeNull());
    await http()
      .get('/api/digests')
      .set('Authorization', auth)
      .expect((res) => expect(res.body.unreadCount).toBe(1));
  });

  it('filtre par période', async () => {
    const { auth, userId } = await login();
    await report(userId, { period: 'TODAY' });
    await report(userId, { period: 'WEEK' });

    const week = await http()
      .get('/api/digests?period=WEEK')
      .set('Authorization', auth)
      .expect(200);
    expect(week.body.items).toHaveLength(1);
    expect(week.body.items[0].period).toBe('WEEK');
  });

  it.each([
    ['limit=0'],
    ['limit=101'],
    ['limit=abc'],
    ['before=hier'],
    ['period=YESTERDAY_OR_NOT'],
    ['period=today'],
  ])('refuse la requête invalide ?%s', async (query) => {
    const { auth } = await login();
    await http()
      .get(`/api/digests?${query}`)
      .set('Authorization', auth)
      .expect(400);
  });

  it('isole les utilisateurs et refuse un identifiant invalide', async () => {
    const owner = await login('a@example.com');
    const other = await login('b@example.com');
    const { id } = await report(owner.userId);

    await http()
      .get(`/api/digests/${id}`)
      .set('Authorization', other.auth)
      .expect(404);
    await http()
      .post(`/api/digests/${id}/read`)
      .set('Authorization', other.auth)
      .expect(404);
    await http()
      .get('/api/digests/pas-un-uuid')
      .set('Authorization', owner.auth)
      .expect(400);
    await http()
      .get('/api/digests')
      .set('Authorization', other.auth)
      .expect((res) => expect(res.body).toEqual({ items: [], unreadCount: 0 }));
  });
});
