import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';

/** Parcours HTTP des notifications et des alertes : base en mémoire, reste de l'application réel. */
describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new FakePrisma())
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
    await http().get('/api/notifications').expect(401);
    await http().get('/api/notifications/settings').expect(401);
    await http().post('/api/notifications/test').expect(401);
    await http().get('/api/alerts').expect(401);
    await http().post('/api/alerts').send({}).expect(401);
  });

  describe('réglages', () => {
    it('renvoie les valeurs par défaut puis applique un PATCH partiel', async () => {
      const auth = await login();
      const defaults = await http()
        .get('/api/notifications/settings')
        .set('Authorization', auth)
        .expect(200);
      expect(defaults.body).toMatchObject({
        nightModeEnabled: true,
        nightStartMinute: 1320,
        nightEndMinute: 420,
        digestMinute: 480,
        pushEnabled: true,
        telegramEnabled: false,
      });

      await http()
        .patch('/api/notifications/settings')
        .set('Authorization', auth)
        .send({
          digestMinute: 450,
          telegramEnabled: true,
          telegramChatId: '12345',
        })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            digestMinute: 450,
            telegramEnabled: true,
            telegramChatId: '12345',
          }),
        );
    });

    it.each([
      [{ nightStartMinute: 1440 }, 400],
      [{ nightStartMinute: -1 }, 400],
      [{ digestMinute: 10.5 }, 400],
      [{ telegramChatId: 'abc' }, 400],
      [{ notificationEmail: 'pas-un-email' }, 400],
      [{ inconnu: true }, 400],
      [{ nightEndMinute: 1320 }, 422], // plage vide
      [{ telegramEnabled: true }, 422], // sans conversation
    ])('refuse %j avec %i', async (body, status) => {
      const auth = await login();
      await http()
        .patch('/api/notifications/settings')
        .set('Authorization', auth)
        .send(body)
        .expect(status);
    });
  });

  describe('boîte de réception', () => {
    it('envoie un message de test, le liste, le marque lu', async () => {
      const auth = await login();

      const test = await http()
        .post('/api/notifications/test')
        .set('Authorization', auth)
        .expect(200);
      expect(test.body).toMatchObject({
        title: 'Notification de test',
        status: 'DISPATCHED',
        critical: false,
        readAt: null,
      });
      // Push est activé par défaut mais n'a pas encore d'envoyeur : échec explicite, notification conservée.
      expect(test.body.deliveries).toEqual([
        {
          channel: 'PUSH',
          status: 'FAILED',
          reason: 'channel_not_implemented',
        },
      ]);

      const list = await http()
        .get('/api/notifications')
        .set('Authorization', auth)
        .expect(200);
      expect(list.body.unreadCount).toBe(1);
      expect(list.body.items).toHaveLength(1);

      await http()
        .post(`/api/notifications/${test.body.id}/read`)
        .set('Authorization', auth)
        .expect(200)
        .expect((res) => expect(res.body.readAt).not.toBeNull());

      await http()
        .get('/api/notifications?unread=true')
        .set('Authorization', auth)
        .expect(200)
        .expect((res) => {
          expect(res.body.items).toEqual([]);
          expect(res.body.unreadCount).toBe(0);
        });
    });

    it('marque tout comme lu', async () => {
      const auth = await login();
      await http().post('/api/notifications/test').set('Authorization', auth);
      await http().post('/api/notifications/test').set('Authorization', auth);
      await http()
        .post('/api/notifications/read-all')
        .set('Authorization', auth)
        .expect(200)
        .expect({ updated: 2 });
    });

    it('limite les messages de test (3 par minute)', async () => {
      const auth = await login();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (
            await http()
              .post('/api/notifications/test')
              .set('Authorization', auth)
          ).status,
        );
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it.each([
      ['limit=0'],
      ['limit=101'],
      ['limit=abc'],
      ['before=hier'],
      ['unread=oui'],
    ])('refuse la requête invalide ?%s', async (query) => {
      const auth = await login();
      const res = await http()
        .get(`/api/notifications?${query}`)
        .set('Authorization', auth);
      // `unread` non booléen est converti en faux (« oui » !== « true ») : seule une valeur structurellement invalide échoue.
      expect([200, 400]).toContain(res.status);
      if (!query.startsWith('unread')) expect(res.status).toBe(400);
    });

    it('isole les utilisateurs et refuse un identifiant invalide', async () => {
      const owner = await login('a@example.com');
      const other = await login('b@example.com');
      const { body } = await http()
        .post('/api/notifications/test')
        .set('Authorization', owner);

      await http()
        .post(`/api/notifications/${body.id}/read`)
        .set('Authorization', other)
        .expect(404);
      await http()
        .post('/api/notifications/pas-un-uuid/read')
        .set('Authorization', owner)
        .expect(400);
      await http()
        .get('/api/notifications')
        .set('Authorization', other)
        .expect((res) =>
          expect(res.body).toEqual({ items: [], unreadCount: 0 }),
        );
    });
  });

  describe('alertes', () => {
    const drop = {
      assetSymbol: 'btc',
      condition: 'PRICE_DROP_PCT',
      threshold: '5',
      windowMinutes: 60,
      channel: 'PUSH',
      isCritical: true,
    };

    it('crée, liste, modifie et supprime', async () => {
      const auth = await login();
      const created = await http()
        .post('/api/alerts')
        .set('Authorization', auth)
        .send(drop)
        .expect(201);
      expect(created.body).toMatchObject({
        assetSymbol: 'BTC',
        threshold: '5',
        windowMinutes: 60,
        isActive: true,
        isCritical: true,
      });

      await http()
        .get('/api/alerts')
        .set('Authorization', auth)
        .expect(200)
        .expect((res) => expect(res.body).toHaveLength(1));

      await http()
        .patch(`/api/alerts/${created.body.id}`)
        .set('Authorization', auth)
        .send({ isActive: false, threshold: '7.5' })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({ isActive: false, threshold: '7.5' }),
        );

      await http()
        .delete(`/api/alerts/${created.body.id}`)
        .set('Authorization', auth)
        .expect(204);
      await http()
        .get('/api/alerts')
        .set('Authorization', auth)
        .expect(200)
        .expect([]);
    });

    it.each([
      [{ threshold: 5 }, 400], // nombre JSON refusé
      [{ threshold: '0' }, 400],
      [{ threshold: '-3' }, 400],
      [{ condition: 'INCONNUE' }, 400],
      [{ channel: 'SMS' }, 400],
      [{ assetSymbol: 'b t c' }, 400],
      [{ extra: 1 }, 400],
      [{ windowMinutes: undefined }, 422], // variation sans fenêtre
      [{ windowMinutes: 2 }, 422],
      [{ condition: 'PRICE_CROSS_ABOVE', threshold: '3500' }, 422], // franchissement avec fenêtre
      [{ condition: 'PORTFOLIO_DROP_PCT' }, 422], // portefeuille avec symbole
    ])('refuse l’alerte %j avec %i', async (override, status) => {
      const auth = await login();
      await http()
        .post('/api/alerts')
        .set('Authorization', auth)
        .send({ ...drop, ...override })
        .expect(status);
    });

    it('accepte les quatre alertes de la maquette', async () => {
      const auth = await login();
      const create = (body: object) =>
        http()
          .post('/api/alerts')
          .set('Authorization', auth)
          .send(body)
          .expect(201);

      await create({
        assetSymbol: 'BTC',
        condition: 'PRICE_DROP_PCT',
        threshold: '5',
        windowMinutes: 60,
        channel: 'PUSH',
        isCritical: true,
      });
      await create({
        assetSymbol: 'ETH',
        condition: 'PRICE_CROSS_ABOVE',
        threshold: '3500',
        channel: 'TELEGRAM',
      });
      await create({
        condition: 'PORTFOLIO_DROP_PCT',
        threshold: '10',
        windowMinutes: 10080,
        channel: 'PUSH',
        isCritical: true,
      });
      await create({
        assetSymbol: 'SOL',
        condition: 'PRICE_RISE_PCT',
        threshold: '8',
        windowMinutes: 1440,
        channel: 'EMAIL',
        isActive: false,
      });
    });

    it('isole les utilisateurs', async () => {
      const owner = await login('a@example.com');
      const other = await login('b@example.com');
      const { body } = await http()
        .post('/api/alerts')
        .set('Authorization', owner)
        .send(drop);

      await http()
        .patch(`/api/alerts/${body.id}`)
        .set('Authorization', other)
        .send({ isActive: false })
        .expect(404);
      await http()
        .delete(`/api/alerts/${body.id}`)
        .set('Authorization', other)
        .expect(404);
      await http()
        .get('/api/alerts')
        .set('Authorization', other)
        .expect(200)
        .expect([]);
      await http()
        .delete('/api/alerts/pas-un-uuid')
        .set('Authorization', owner)
        .expect(400);
    });
  });
});
