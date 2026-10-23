import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';

const credentials = {
  email: 'client@example.com',
  password: 'un-mot-de-passe-solide',
};

/** Parcours HTTP complet avec une base en mémoire (le reste de l'application est réel). */
describe('Auth (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new FakePrisma())
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

  const refreshCookie = (res: request.Response) =>
    (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    )!;

  it('register → me → refresh → logout', async () => {
    const http = request(app.getHttpServer());

    const registered = await http
      .post('/api/auth/register')
      .send(credentials)
      .expect(201);
    expect(registered.body.accessToken).toBeTruthy();
    expect(registered.body.user.email).toBe(credentials.email);

    const cookie = refreshCookie(registered);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(registered.body.refreshToken).toBeUndefined();

    await http
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${registered.body.accessToken}`)
      .expect(200)
      .expect((res) => expect(res.body.email).toBe(credentials.email));

    const refreshed = await http
      .post('/api/auth/refresh')
      .set('Cookie', cookie.split(';')[0])
      .expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();

    // L'ancien refresh token est consommé : le rejouer est refusé.
    await http
      .post('/api/auth/refresh')
      .set('Cookie', cookie.split(';')[0])
      .expect(401);

    await http.post('/api/auth/logout').expect(204);
  });

  it('protège les routes par défaut', async () => {
    const http = request(app.getHttpServer());
    await http.get('/api/auth/me').expect(401);
    await http
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalide')
      .expect(401);
    await http.get('/api').expect(200);
  });

  it('valide les entrées', async () => {
    const http = request(app.getHttpServer());
    await http
      .post('/api/auth/register')
      .send({ email: 'pas-un-email', password: 'court' })
      .expect(400);
    await http
      .post('/api/auth/register')
      .send({ ...credentials, role: 'admin' })
      .expect(400);
  });

  it('refuse de se connecter avec de mauvais identifiants', async () => {
    const http = request(app.getHttpServer());
    await http.post('/api/auth/register').send(credentials).expect(201);
    await http
      .post('/api/auth/login')
      .send({ ...credentials, password: 'mauvais' })
      .expect(401);
  });

  it('limite le débit des tentatives de connexion', async () => {
    const http = request(app.getHttpServer());
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push(
        (
          await http
            .post('/api/auth/login')
            .send({ ...credentials, password: 'mauvais' })
        ).status,
      );
    }
    expect(statuses.slice(0, 5)).toEqual(Array(5).fill(401));
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
