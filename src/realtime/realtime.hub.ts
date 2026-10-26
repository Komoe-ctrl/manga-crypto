import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TokenService } from '../auth/token.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RealtimeEvent } from './realtime-events.js';

/** Codes de fermeture applicatifs (plage 4000-4999 réservée par la RFC 6455). */
export const CLOSE = {
  UNAUTHORIZED: 4401,
  AUTH_TIMEOUT: 4408,
  TOO_MANY_CONNECTIONS: 4429,
} as const;

const WS_OPEN = 1;
const MAX_TOKEN_LENGTH = 2048;
/** Plafond de `setTimeout` (délai sur 32 bits signés). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Ce que le hub utilise d'un `WebSocket` (celui de la bibliothèque `ws`) : permet de tester avec un faux. */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
}

interface Session {
  userId: string | null;
  /** Faux depuis le dernier ping tant qu'aucun pong n'est revenu. */
  alive: boolean;
  authTimer: NodeJS.Timeout | null;
  expiryTimer: NodeJS.Timeout | null;
}

/**
 * Registre des connexions WebSocket : authentification par premier message, isolation par utilisateur, limites et
 * détection des connexions mortes. Aucune logique de transport ici (voir `RealtimeGateway`).
 */
@Injectable()
export class RealtimeHub {
  private readonly logger = new Logger(RealtimeHub.name);
  private readonly sessions = new Map<RealtimeSocket, Session>();
  private readonly byUser = new Map<string, Set<RealtimeSocket>>();
  private readonly authTimeoutMs: number;
  private readonly maxPerUser: number;

  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.authTimeoutMs = positive(config.get('REALTIME_AUTH_TIMEOUT_MS'), 5000);
    this.maxPerUser = positive(
      config.get('REALTIME_MAX_CONNECTIONS_PER_USER'),
      5,
    );
  }

  /** Nouvelle connexion : elle doit s'authentifier avant le délai, sinon elle est fermée. */
  open(socket: RealtimeSocket): void {
    this.sessions.set(socket, {
      userId: null,
      alive: true,
      authTimer: setTimeout(
        () => this.reject(socket, CLOSE.AUTH_TIMEOUT, 'auth_timeout'),
        this.authTimeoutMs,
      ),
      expiryTimer: null,
    });
  }

  /**
   * Premier message `auth` (ou renouvellement avec un nouveau jeton, pour le même utilisateur). Le jeton n'est
   * jamais journalisé. Toute erreur ferme la connexion : le client se reconnecte avec un jeton valide.
   */
  async authenticate(socket: RealtimeSocket, token: unknown): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return;
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH
    )
      return this.reject(socket, CLOSE.UNAUTHORIZED, 'unauthorized');

    let userId: string;
    let expiresAtMs: number | null;
    try {
      const payload = await this.tokens.verifyAccessToken(token);
      userId = payload.sub;
      expiresAtMs = payload.exp ? payload.exp * 1000 : null;
    } catch {
      return this.reject(socket, CLOSE.UNAUTHORIZED, 'unauthorized');
    }
    // Un compte désactivé perd l'accès immédiatement, comme pour l'API HTTP.
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!this.sessions.has(socket)) return; // fermée pendant la vérification
    if (!user) return this.reject(socket, CLOSE.UNAUTHORIZED, 'unauthorized');

    if (session.userId !== null && session.userId !== userId)
      return this.reject(socket, CLOSE.UNAUTHORIZED, 'unauthorized');

    if (session.userId === null) {
      const peers = this.byUser.get(userId);
      if (peers && peers.size >= this.maxPerUser)
        return this.reject(
          socket,
          CLOSE.TOO_MANY_CONNECTIONS,
          'too_many_connections',
        );
      session.userId = userId;
      if (peers) peers.add(socket);
      else this.byUser.set(userId, new Set([socket]));
    }

    if (session.authTimer) clearTimeout(session.authTimer);
    session.authTimer = null;
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
    if (expiresAtMs !== null) {
      session.expiryTimer = setTimeout(
        () => this.reject(socket, CLOSE.UNAUTHORIZED, 'token_expired'),
        Math.min(Math.max(expiresAtMs - Date.now(), 0), MAX_TIMER_MS),
      );
    }

    this.send(socket, {
      event: 'ready',
      data: {
        expiresAt:
          expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      },
    });
  }

  /** Envoie un événement aux connexions authentifiées de cet utilisateur, et à elles seules. */
  deliver(userId: string, event: RealtimeEvent): void {
    const sockets = this.byUser.get(userId);
    if (!sockets) return;
    const message = JSON.stringify({ event: event.type, data: event.data });
    for (const socket of sockets) {
      if (socket.readyState !== WS_OPEN) continue;
      try {
        socket.send(message);
      } catch {
        socket.terminate(); // le nettoyage se fait à la fermeture
      }
    }
  }

  onPong(socket: RealtimeSocket): void {
    const session = this.sessions.get(socket);
    if (session) session.alive = true;
  }

  /** Passage périodique : coupe les connexions qui n'ont pas répondu au ping précédent, puis ping les autres. */
  heartbeat(): void {
    for (const [socket, session] of this.sessions) {
      if (!session.alive) {
        socket.terminate();
        continue;
      }
      session.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }

  /** Connexion fermée (par l'une ou l'autre des parties) : libère tout ce qui lui était associé. */
  remove(socket: RealtimeSocket): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    if (session.authTimer) clearTimeout(session.authTimer);
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    this.sessions.delete(socket);
    if (session.userId) {
      const peers = this.byUser.get(session.userId);
      peers?.delete(socket);
      if (peers?.size === 0) this.byUser.delete(session.userId);
    }
  }

  closeAll(): void {
    // Supprimer l'entrée courante d'une Map pendant son parcours est sans danger.
    for (const socket of this.sessions.keys()) {
      try {
        socket.close(1001, 'server_shutdown');
      } catch {
        socket.terminate();
      }
      this.remove(socket);
    }
  }

  connectionCount(userId?: string): number {
    return userId ? (this.byUser.get(userId)?.size ?? 0) : this.sessions.size;
  }

  private reject(socket: RealtimeSocket, code: number, reason: string): void {
    this.send(socket, { event: 'error', data: { code: reason } });
    try {
      socket.close(code, reason);
    } catch (error) {
      this.logger.debug(
        `Fermeture impossible : ${error instanceof Error ? error.name : 'erreur'}`,
      );
      socket.terminate();
    }
    this.remove(socket);
  }

  private send(socket: RealtimeSocket, message: unknown): void {
    if (socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* la connexion est déjà en train de se fermer */
    }
  }
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
