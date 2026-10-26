import type { ConfigService } from '@nestjs/config';
import type { TokenService } from '../auth/token.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { OrderView } from '../orders/orders.types.js';
import { CLOSE, RealtimeHub, type RealtimeSocket } from './realtime.hub.js';

class FakeSocket implements RealtimeSocket {
  readyState = 1;
  sent: { event: string; data: unknown }[] = [];
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  pings = 0;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  ping() {
    this.pings++;
  }
}

const NOW = new Date('2026-10-26T10:00:00Z');
const inSeconds = (s: number) => Math.floor(NOW.getTime() / 1000) + s;

function setup(
  options: { users?: string[]; config?: Record<string, unknown> } = {},
) {
  const activeUsers = new Set(options.users ?? ['u1', 'u2']);
  const tokens = {
    // « token-<id>[:<secondes avant expiration>] »
    verifyAccessToken: vi.fn(async (token: string) => {
      const match = /^token-(\w+)(?::(\d+))?$/.exec(token);
      if (!match) throw new Error('jwt malformed');
      return {
        sub: match[1],
        ...(match[2] !== undefined && { exp: inSeconds(Number(match[2])) }),
      };
    }),
  };
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        activeUsers.has(where.id) ? { id: where.id } : null,
      ),
    },
  };
  const config = { get: (key: string) => options.config?.[key] };
  const hub = new RealtimeHub(
    tokens as unknown as TokenService,
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
  );
  return { hub, activeUsers };
}

const order = (id: string) =>
  ({ id, status: 'FILLED', quantity: '0.5' }) as unknown as OrderView;

describe('RealtimeHub', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('authentification', () => {
    it('accepte un jeton valide et répond « ready » avec la date d’expiration', async () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);

      await hub.authenticate(socket, 'token-u1:900');

      expect(socket.sent).toEqual([
        { event: 'ready', data: { expiresAt: '2026-10-26T10:15:00.000Z' } },
      ]);
      expect(socket.closed).toBeNull();
      expect(hub.connectionCount('u1')).toBe(1);
    });

    it.each([
      ['jeton invalide', 'pas-un-jeton'],
      ['jeton absent', undefined],
      ['jeton vide', ''],
      ['jeton qui n’est pas une chaîne', 42],
      ['jeton démesuré', 'x'.repeat(3000)],
    ])('ferme la connexion (4401) : %s', async (_label, token) => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);

      await hub.authenticate(socket, token);

      expect(socket.closed?.code).toBe(CLOSE.UNAUTHORIZED);
      expect(socket.sent).toEqual([
        { event: 'error', data: { code: 'unauthorized' } },
      ]);
      expect(hub.connectionCount()).toBe(0);
    });

    it('refuse un compte désactivé même avec un jeton encore valide', async () => {
      const { hub } = setup({ users: [] });
      const socket = new FakeSocket();
      hub.open(socket);
      await hub.authenticate(socket, 'token-u1:900');
      expect(socket.closed?.code).toBe(CLOSE.UNAUTHORIZED);
    });

    it('ferme une connexion qui ne s’authentifie pas dans le délai (4408)', () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);

      vi.advanceTimersByTime(4999);
      expect(socket.closed).toBeNull();
      vi.advanceTimersByTime(1);

      expect(socket.closed?.code).toBe(CLOSE.AUTH_TIMEOUT);
      expect(hub.connectionCount()).toBe(0);
    });

    it('le délai d’authentification est réglable et ne court plus une fois authentifié', async () => {
      const { hub } = setup({ config: { REALTIME_AUTH_TIMEOUT_MS: '1000' } });
      const late = new FakeSocket();
      const ok = new FakeSocket();
      hub.open(late);
      hub.open(ok);
      await hub.authenticate(ok, 'token-u1:900');

      vi.advanceTimersByTime(1000);

      expect(late.closed?.code).toBe(CLOSE.AUTH_TIMEOUT);
      expect(ok.closed).toBeNull();
    });

    it('coupe la connexion à l’expiration du jeton (4401)', async () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);
      await hub.authenticate(socket, 'token-u1:60');

      vi.advanceTimersByTime(59_000);
      expect(socket.closed).toBeNull();
      vi.advanceTimersByTime(1000);

      expect(socket.closed).toEqual({
        code: CLOSE.UNAUTHORIZED,
        reason: 'token_expired',
      });
      expect(hub.connectionCount('u1')).toBe(0);
    });

    it('un nouveau jeton du même utilisateur prolonge la connexion sans la couper', async () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);
      await hub.authenticate(socket, 'token-u1:60');
      vi.advanceTimersByTime(30_000);

      await hub.authenticate(socket, 'token-u1:900');
      vi.advanceTimersByTime(60_000); // l’ancienne échéance est passée

      expect(socket.closed).toBeNull();
      expect(hub.connectionCount('u1')).toBe(1);
      expect(socket.sent.filter((m) => m.event === 'ready')).toHaveLength(2);
    });

    it('refuse un jeton d’un autre utilisateur sur une connexion déjà authentifiée', async () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);
      await hub.authenticate(socket, 'token-u1:900');

      await hub.authenticate(socket, 'token-u2:900');

      expect(socket.closed?.code).toBe(CLOSE.UNAUTHORIZED);
      expect(hub.connectionCount('u1')).toBe(0);
      expect(hub.connectionCount('u2')).toBe(0);
    });

    it('limite les connexions par utilisateur (4429), sans gêner les autres', async () => {
      const { hub } = setup({
        config: { REALTIME_MAX_CONNECTIONS_PER_USER: '2' },
      });
      const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
      for (const socket of sockets) {
        hub.open(socket);
        await hub.authenticate(socket, 'token-u1:900');
      }
      const other = new FakeSocket();
      hub.open(other);
      await hub.authenticate(other, 'token-u2:900');

      expect(sockets[2].closed?.code).toBe(CLOSE.TOO_MANY_CONNECTIONS);
      expect(sockets[0].closed).toBeNull();
      expect(sockets[1].closed).toBeNull();
      expect(other.closed).toBeNull();
      expect(hub.connectionCount('u1')).toBe(2);
    });

    it('libère la place d’une connexion fermée', async () => {
      const { hub } = setup({
        config: { REALTIME_MAX_CONNECTIONS_PER_USER: '1' },
      });
      const first = new FakeSocket();
      hub.open(first);
      await hub.authenticate(first, 'token-u1:900');
      hub.remove(first);

      const second = new FakeSocket();
      hub.open(second);
      await hub.authenticate(second, 'token-u1:900');

      expect(second.closed).toBeNull();
      expect(hub.connectionCount('u1')).toBe(1);
    });

    it('ignore une authentification qui se termine après la fermeture de la connexion', async () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);
      const pending = hub.authenticate(socket, 'token-u1:900');
      hub.remove(socket); // le client est parti pendant la vérification
      await pending;

      expect(hub.connectionCount('u1')).toBe(0);
      expect(socket.sent).toEqual([]);
    });
  });

  describe('diffusion', () => {
    it('n’envoie un événement qu’aux connexions authentifiées de son utilisateur', async () => {
      const { hub } = setup();
      const a1 = new FakeSocket();
      const a2 = new FakeSocket();
      const b = new FakeSocket();
      const anonymous = new FakeSocket();
      for (const [socket, token] of [
        [a1, 'token-u1:900'],
        [a2, 'token-u1:900'],
        [b, 'token-u2:900'],
      ] as const) {
        hub.open(socket);
        await hub.authenticate(socket, token);
      }
      hub.open(anonymous);

      hub.deliver('u1', { type: 'order', data: order('o1') });

      const received = (s: FakeSocket) =>
        s.sent.filter((m) => m.event === 'order');
      expect(received(a1)).toEqual([{ event: 'order', data: order('o1') }]);
      expect(received(a2)).toHaveLength(1);
      expect(received(b)).toHaveLength(0);
      expect(anonymous.sent).toEqual([]);
    });

    it('ne diffuse rien à un utilisateur sans connexion', () => {
      const { hub } = setup();
      expect(() =>
        hub.deliver('personne', { type: 'order', data: order('o1') }),
      ).not.toThrow();
    });

    it('une connexion qui échoue à l’envoi est coupée sans empêcher les autres de recevoir', async () => {
      const { hub } = setup();
      const broken = new FakeSocket();
      broken.send = () => {
        throw new Error('EPIPE');
      };
      const healthy = new FakeSocket();
      for (const socket of [broken, healthy]) {
        hub.open(socket);
        await hub.authenticate(socket, 'token-u1:900');
      }
      healthy.sent = [];

      hub.deliver('u1', { type: 'order', data: order('o1') });

      expect(broken.terminated).toBe(true);
      expect(healthy.sent).toHaveLength(1);
    });

    it('saute les connexions qui ne sont plus ouvertes', async () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);
      await hub.authenticate(socket, 'token-u1:900');
      socket.sent = [];
      socket.readyState = 2; // CLOSING

      hub.deliver('u1', { type: 'order', data: order('o1') });

      expect(socket.sent).toEqual([]);
    });
  });

  describe('heartbeat', () => {
    it('envoie un ping, puis coupe la connexion qui n’a pas répondu', () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);

      hub.heartbeat();
      expect(socket.pings).toBe(1);
      expect(socket.terminated).toBe(false);

      hub.heartbeat(); // aucun pong entre-temps
      expect(socket.terminated).toBe(true);
    });

    it('garde la connexion qui répond par un pong', () => {
      const { hub } = setup();
      const socket = new FakeSocket();
      hub.open(socket);

      hub.heartbeat();
      hub.onPong(socket);
      hub.heartbeat();

      expect(socket.terminated).toBe(false);
      expect(socket.pings).toBe(2);
    });
  });

  it('closeAll ferme tout et vide le registre', async () => {
    const { hub } = setup();
    const socket = new FakeSocket();
    hub.open(socket);
    await hub.authenticate(socket, 'token-u1:900');

    hub.closeAll();

    expect(socket.closed?.code).toBe(1001);
    expect(hub.connectionCount()).toBe(0);
    // Plus aucun minuteur en attente : la connexion ne sera pas refermée une seconde fois.
    vi.advanceTimersByTime(3_600_000);
    expect(socket.closed?.code).toBe(1001);
  });
});
