import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { PriceProvider } from '../src/portfolio/price/price-provider.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePrisma } from './support/fake-prisma.js';

interface Message {
  event: string;
  data: Record<string, unknown>;
}

/** Client de test : conserve tous les messages reçus et le code de fermeture. */
class Client {
  readonly messages: Message[] = [];
  closeCode: number | null = null;
  private readonly socket: WebSocket;
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw: WebSocket.RawData) =>
      this.messages.push(JSON.parse(raw.toString()) as Message),
    );
    this.socket.on('close', (code: number) => (this.closeCode = code));
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: unknown) {
    this.socket.send(
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }

  auth(token: string) {
    this.send({ event: 'auth', data: { token } });
  }

  async waitFor(
    predicate: (messages: Message[]) => boolean,
    label: string,
    timeoutMs = 4000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.messages)) {
      if (Date.now() > deadline)
        throw new Error(
          `Délai dépassé : ${label} (reçu : ${JSON.stringify(this.messages)})`,
        );
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  waitForEvent(event: string, where: (m: Message) => boolean = () => true) {
    return this.waitFor(
      (all) => all.some((m) => m.event === event && where(m)),
      `événement « ${event} »`,
    );
  }

  async waitForClose(): Promise<number> {
    await this.waitFor(() => this.closeCode !== null, 'fermeture');
    return this.closeCode!;
  }

  close() {
    this.socket.close();
  }
}

/** WebSocket de bout en bout : vrai serveur HTTP + WsAdapter, base en mémoire, prix simulés. */
describe('Realtime (e2e)', () => {
  let app: INestApplication<App>;
  let url: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(48);
    process.env.REALTIME_AUTH_TIMEOUT_MS = '400';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new FakePrisma())
      .overrideProvider(PriceProvider)
      .useValue({
        getPrices: async (symbols: string[]) =>
          new Map(
            symbols.map((s) => [
              s,
              s === 'BTC'
                ? new Prisma.Decimal(100)
                : s === 'USDT'
                  ? new Prisma.Decimal(1)
                  : null,
            ]),
          ),
        getPriceAt: async () => null,
      })
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
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    url = `ws://127.0.0.1:${address.port}/api/ws`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    delete process.env.REALTIME_AUTH_TIMEOUT_MS;
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function register(email: string) {
    const res = await http()
      .post('/api/auth/register')
      .send({ email, password: 'un-mot-de-passe-solide' })
      .expect(201);
    return res.body.accessToken as string;
  }

  async function connect(token?: string) {
    const client = new Client(url);
    clients.push(client);
    await client.opened;
    if (token) client.auth(token);
    return client;
  }

  async function ready(token: string) {
    const client = await connect(token);
    await client.waitForEvent('ready');
    return client;
  }

  it('authentifie la connexion par un premier message et répond « ready »', async () => {
    const token = await register('a@example.com');
    const client = await ready(token);

    const message = client.messages.find((m) => m.event === 'ready')!;
    expect(typeof message.data.expiresAt).toBe('string');
    expect(client.closeCode).toBeNull();
  });

  it('ferme (4401) une connexion avec un jeton invalide', async () => {
    const client = await connect('pas-un-jeton');
    expect(await client.waitForClose()).toBe(4401);
    expect(client.messages).toEqual([
      { event: 'error', data: { code: 'unauthorized' } },
    ]);
  });

  it('ferme (4408) une connexion qui ne s’authentifie pas', async () => {
    const client = await connect();
    expect(await client.waitForClose()).toBe(4408);
  });

  it('ferme (1009) un message trop volumineux', async () => {
    const client = await connect();
    client.send('x'.repeat(10_000));
    expect(await client.waitForClose()).toBe(1009);
  });

  it('survit à un message qui n’est pas du JSON et à un événement inconnu', async () => {
    const token = await register('a@example.com');
    const client = await connect();
    client.send('pas du json');
    client.send({ event: 'inconnu', data: {} });
    client.auth(token);

    await client.waitForEvent('ready');
    expect(client.closeCode).toBeNull();
  });

  it('pousse l’évolution d’un ordre PAPER, jusqu’à l’exécution, en chaînes décimales', async () => {
    const token = await register('a@example.com');
    const auth = `Bearer ${token}`;
    await http()
      .put('/api/portfolio/assets/USDT')
      .set('Authorization', auth)
      .send({ quantity: '10000', avgBuyPrice: '1' })
      .expect(200);
    const client = await ready(token);

    const res = await http()
      .post('/api/orders')
      .set('Authorization', auth)
      .send({ symbol: 'btc', side: 'BUY', quantity: '2' })
      .expect(201);

    await client.waitForEvent(
      'order',
      (m) => m.data.id === res.body.id && m.data.status === 'FILLED',
    );
    const orders = client.messages.filter((m) => m.event === 'order');
    expect(orders.map((m) => m.data.status)).toEqual([
      'PENDING',
      'SUBMITTED',
      'FILLED',
    ]);
    expect(orders.at(-1)!.data).toMatchObject({
      id: res.body.id,
      symbol: 'BTC/USDT',
      side: 'BUY',
      quantity: '2',
      filledQuantity: '2',
      avgFillPrice: '100',
    });
  });

  it('pousse un ordre refusé avec son motif', async () => {
    const token = await register('a@example.com');
    const client = await ready(token);

    await http()
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'btc', side: 'BUY', quantity: '2' }); // aucun fonds

    await client.waitForEvent('order', (m) => m.data.status === 'REJECTED');
    const rejected = client.messages.find(
      (m) => m.event === 'order' && m.data.status === 'REJECTED',
    )!;
    expect(rejected.data.failureReason).toEqual(expect.any(String));
  });

  it('pousse l’état du robot quand le kill switch change', async () => {
    const token = await register('a@example.com');
    const auth = `Bearer ${token}`;
    const client = await ready(token);

    await http()
      .post('/api/risk/kill-switch/activate')
      .set('Authorization', auth)
      .expect(200);
    await client.waitForEvent('risk', (m) => m.data.killSwitchActive === true);
    expect(client.messages.find((m) => m.event === 'risk')!.data).toMatchObject(
      { canTrade: false, blockedReason: 'KILL_SWITCH', tradingMode: 'PAPER' },
    );

    await http()
      .post('/api/risk/kill-switch/deactivate')
      .set('Authorization', auth)
      .expect(200);
    await client.waitForEvent('risk', (m) => m.data.canTrade === true);
  });

  it('pousse les notifications, sans aucun secret ni détail de livraison', async () => {
    const token = await register('a@example.com');
    const client = await ready(token);

    await http()
      .post('/api/notifications/test')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);

    await client.waitForEvent('notification');
    const data = client.messages.find((m) => m.event === 'notification')!.data;
    expect(Object.keys(data).sort()).toEqual([
      'body',
      'createdAt',
      'critical',
      'id',
      'status',
      'title',
    ]);
  });

  it('cloisonne les utilisateurs : chacun ne reçoit que ses propres événements', async () => {
    const tokenA = await register('a@example.com');
    const tokenB = await register('b@example.com');
    const a = await ready(tokenA);
    const b = await ready(tokenB);

    await http()
      .post('/api/risk/kill-switch/activate')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    await a.waitForEvent('risk');
    // B agit à son tour : si l'événement de A avait fuité, il serait déjà arrivé chez B avant celui-ci.
    await http()
      .post('/api/risk/kill-switch/activate')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    await b.waitForEvent('risk');

    expect(a.messages.filter((m) => m.event === 'risk')).toHaveLength(1);
    expect(b.messages.filter((m) => m.event === 'risk')).toHaveLength(1);
  });

  it('ne reçoit plus rien après un jeton refusé, même si l’utilisateur existe', async () => {
    const token = await register('a@example.com');
    const client = await connect('x' + token.slice(1)); // signature invalide
    expect(await client.waitForClose()).toBe(4401);

    await http()
      .post('/api/risk/kill-switch/activate')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(client.messages.filter((m) => m.event === 'risk')).toEqual([]);
  });

  it('l’API HTTP reste protégée par ses gardes habituelles', async () => {
    await http().get('/api/orders').expect(401);
  });
});
