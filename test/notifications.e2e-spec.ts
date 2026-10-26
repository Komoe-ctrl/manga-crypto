import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import {
  MailTransport,
  type MailMessage,
} from '../src/notifications/email/mail-transport.js';
import {
  PushHttpError,
  WebPushClient,
} from '../src/notifications/push/web-push.client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';
import { chromeSubscription, pushKeys } from './support/push-keys.js';

/** Faux service Push : enregistre les envois, aucun appel réseau. */
class FakePush extends WebPushClient {
  sent: { endpoint: string; payload: string; urgency: string }[] = [];
  failWith?: Error;
  send(
    subscription: { endpoint: string },
    payload: string,
    _vapid: unknown,
    options: { urgency: string },
  ): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push({
      endpoint: subscription.endpoint,
      payload,
      urgency: options.urgency,
    });
    return Promise.resolve();
  }
}

/** Faux serveur SMTP : enregistre les messages. */
class FakeMail extends MailTransport {
  sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Parcours HTTP des notifications et des alertes : base en mémoire, reste de l'application réel. */
describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;
  let push: FakePush;
  let mail: FakeMail;

  beforeEach(async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    push = new FakePush();
    mail = new FakeMail();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new FakePrisma())
      .overrideProvider(WebPushClient)
      .useValue(push)
      .overrideProvider(MailTransport)
      .useValue(mail)
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

  afterEach(async () => {
    for (const key of [
      'VAPID_PUBLIC_KEY',
      'VAPID_PRIVATE_KEY',
      'VAPID_SUBJECT',
      'SMTP_HOST',
      'EMAIL_FROM',
    ])
      delete process.env[key];
    await app.close();
  });

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
      // Push est activé par défaut mais le serveur n'a pas de clés VAPID : échec explicite, notification conservée.
      expect(test.body.deliveries).toEqual([
        {
          channel: 'PUSH',
          status: 'FAILED',
          reason: 'push_not_configured',
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

  describe('Push et Email', () => {
    const configurePush = () => {
      process.env.VAPID_PUBLIC_KEY = 'BClePubliqueDeTest';
      process.env.VAPID_PRIVATE_KEY = 'cle-privee-de-test';
      process.env.VAPID_SUBJECT = 'mailto:admin@example.com';
    };
    const configureMail = () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.EMAIL_FROM = 'Veille <veille@example.com>';
    };
    const subscribe = (auth: string, body: object) =>
      http()
        .put('/api/notifications/push/subscription')
        .set('Authorization', auth)
        .send(body);
    const subscribeDevice = (
      auth: string,
      device: ReturnType<typeof chromeSubscription>,
    ) =>
      subscribe(auth, {
        endpoint: device.endpoint,
        keys: { p256dh: device.p256dh, auth: device.auth },
      });
    const pushCount = (auth: string) =>
      http()
        .get('/api/notifications/push')
        .set('Authorization', auth)
        .expect(200)
        .then((r) => r.body.subscriptions as number);

    it('exige une authentification', async () => {
      await http().get('/api/notifications/push').expect(401);
      await http()
        .put('/api/notifications/push/subscription')
        .send({})
        .expect(401);
      await http()
        .delete('/api/notifications/push/subscription')
        .send({})
        .expect(401);
    });

    it('annonce que le Push n’est pas configuré, sans clé', async () => {
      const auth = await login();
      await http()
        .get('/api/notifications/push')
        .set('Authorization', auth)
        .expect(200)
        .expect({ configured: false, publicKey: null, subscriptions: 0 });
    });

    it('donne la clé publique VAPID, jamais la privée', async () => {
      configurePush();
      const auth = await login();
      const res = await http()
        .get('/api/notifications/push')
        .set('Authorization', auth)
        .expect(200);
      expect(res.body).toEqual({
        configured: true,
        publicKey: 'BClePubliqueDeTest',
        subscriptions: 0,
      });
      expect(JSON.stringify(res.body)).not.toContain('cle-privee');
    });

    it('abonne un appareil avec le corps exact de PushSubscription.toJSON() (expirationTime compris)', async () => {
      const auth = await login();
      const device = chromeSubscription();
      const res = await subscribe(auth, {
        endpoint: device.endpoint,
        expirationTime: null,
        keys: { p256dh: device.p256dh, auth: device.auth },
      }).expect(200);
      expect(res.body.subscriptions).toBe(1);
      // Ni l'adresse ni les clés ne ressortent des réglages.
      const settings = await http()
        .get('/api/notifications/settings')
        .set('Authorization', auth)
        .expect(200);
      expect(JSON.stringify(settings.body)).not.toContain(device.endpoint);
    });

    it('refuse une adresse qui n’est pas un service Push connu (422) : protection contre la SSRF', async () => {
      const auth = await login();
      const keys = pushKeys();
      for (const endpoint of [
        'http://localhost:5432/',
        'https://127.0.0.1/push',
        'https://169.254.169.254/latest/meta-data',
        'https://evil.example/push',
      ]) {
        await subscribe(auth, { endpoint, keys }).expect(422);
      }
      expect(await pushCount(auth)).toBe(0);
    });

    it.each([
      [{ endpoint: 'https://fcm.googleapis.com/x' }, 'sans clés'],
      [
        {
          endpoint: 'https://fcm.googleapis.com/x',
          keys: { p256dh: 'court', auth: 'court' },
        },
        'clés mal formées',
      ],
      [{ keys: pushKeys() }, 'sans adresse'],
      [{ endpoint: 42, keys: pushKeys() }, 'adresse qui n’est pas du texte'],
      [
        {
          endpoint: 'https://fcm.googleapis.com/x',
          keys: pushKeys(),
          extra: 1,
        },
        'champ inconnu',
      ],
    ])('refuse un corps invalide (400) : %j (%s)', async (body, _label) => {
      const auth = await login();
      await subscribe(auth, body).expect(400);
    });

    it('refuse des clés de bonne forme qui ne sont pas un point P-256 (422)', async () => {
      const auth = await login();
      await subscribe(auth, {
        endpoint: 'https://fcm.googleapis.com/x',
        keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) },
      }).expect(422);
    });

    it('retire un appareil, de façon idempotente', async () => {
      const auth = await login();
      const device = chromeSubscription();
      await subscribeDevice(auth, device).expect(200);

      const remove = () =>
        http()
          .delete('/api/notifications/push/subscription')
          .set('Authorization', auth)
          .send({ endpoint: device.endpoint })
          .expect(200);

      expect((await remove()).body.subscriptions).toBe(0);
      expect((await remove()).body.subscriptions).toBe(0);
    });

    it('cloisonne les utilisateurs : l’appareil de l’un n’existe pas pour l’autre', async () => {
      const owner = await login('a@example.com');
      const other = await login('b@example.com');
      const device = chromeSubscription();
      await subscribeDevice(owner, device).expect(200);

      expect(await pushCount(other)).toBe(0);
      // Retirer cette adresse côté de l'autre n'a aucun effet sur l'appareil de son propriétaire.
      await http()
        .delete('/api/notifications/push/subscription')
        .set('Authorization', other)
        .send({ endpoint: device.endpoint })
        .expect(200);
      expect(await pushCount(owner)).toBe(1);
    });

    it('livre un message de test par Push et par Email, avec le détail dans deliveries', async () => {
      configurePush();
      configureMail();
      const auth = await login();
      const device = chromeSubscription();
      await subscribeDevice(auth, device).expect(200);
      await http()
        .patch('/api/notifications/settings')
        .set('Authorization', auth)
        .send({ emailEnabled: true })
        .expect(200);

      const res = await http()
        .post('/api/notifications/test')
        .set('Authorization', auth)
        .expect(200);

      expect(res.body.deliveries).toEqual(
        expect.arrayContaining([
          { channel: 'PUSH', status: 'SENT' },
          { channel: 'EMAIL', status: 'SENT' },
        ]),
      );
      expect(push.sent).toHaveLength(1);
      expect(push.sent[0].endpoint).toBe(device.endpoint);
      expect(JSON.parse(push.sent[0].payload)).toMatchObject({
        title: 'Notification de test',
        critical: false,
      });
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]).toMatchObject({
        to: 'a@example.com',
        subject: 'Notification de test',
      });
    });

    it('écrit à l’adresse de notification quand elle est définie', async () => {
      configureMail();
      const auth = await login();
      await http()
        .patch('/api/notifications/settings')
        .set('Authorization', auth)
        .send({ emailEnabled: true, notificationEmail: 'alertes@example.com' })
        .expect(200);
      await http()
        .post('/api/notifications/test')
        .set('Authorization', auth)
        .expect(200);
      expect(mail.sent[0].to).toBe('alertes@example.com');
    });

    it('signale clairement ce qui manque, sans erreur HTTP', async () => {
      const auth = await login();
      await http()
        .patch('/api/notifications/settings')
        .set('Authorization', auth)
        .send({ emailEnabled: true })
        .expect(200);

      const res = await http()
        .post('/api/notifications/test')
        .set('Authorization', auth)
        .expect(200);

      expect(res.body.deliveries).toEqual(
        expect.arrayContaining([
          { channel: 'PUSH', status: 'FAILED', reason: 'push_not_configured' },
          {
            channel: 'EMAIL',
            status: 'FAILED',
            reason: 'email_not_configured',
          },
        ]),
      );
      // La notification reste dans la boîte de réception malgré l'échec des canaux.
      expect(res.body.title).toBe('Notification de test');
    });

    it('retire un appareil révoqué par le navigateur (410) et le dit', async () => {
      configurePush();
      const auth = await login();
      const device = chromeSubscription();
      await subscribeDevice(auth, device).expect(200);
      push.failWith = new PushHttpError(410);

      const res = await http()
        .post('/api/notifications/test')
        .set('Authorization', auth)
        .expect(200);

      expect(res.body.deliveries).toContainEqual({
        channel: 'PUSH',
        status: 'FAILED',
        reason: 'push_subscription_gone',
      });
      expect(await pushCount(auth)).toBe(0);
    });
  });
});
