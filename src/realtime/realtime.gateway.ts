import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { Public } from '../auth/decorators.js';
import { RealtimeBus } from './realtime-events.js';
import { RealtimeHub } from './realtime.hub.js';

const HEARTBEAT_MS = 30_000;
/** Un message client légitime (`auth`) pèse quelques centaines d'octets (un JWT). */
const MAX_PAYLOAD_BYTES = 4096;

/**
 * Passerelle WebSocket vers crypto-web, sur `/api/ws` (même préfixe que l'API, donc même règle de proxy).
 * Protocole : le client envoie `{"event":"auth","data":{"token":"<access token>"}}` ; le serveur répond
 * `{"event":"ready"}` puis pousse `order`, `risk` et `notification` (SPEC section 8).
 *
 * `@Public()` et `@SkipThrottle()` : les gardes HTTP globales (authentification par en-tête, limitation par IP)
 * ne s'appliquent pas à une connexion WebSocket ; l'authentification est faite par le hub.
 */
@Public()
@SkipThrottle()
@WebSocketGateway({ path: '/api/ws', maxPayload: MAX_PAYLOAD_BYTES })
export class RealtimeGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private unsubscribe?: () => void;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly hub: RealtimeHub,
    private readonly bus: RealtimeBus,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((userId, event) =>
      this.hub.deliver(userId, event),
    );
    this.heartbeat = setInterval(() => this.hub.heartbeat(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.hub.closeAll();
  }

  handleConnection(client: WebSocket): void {
    this.hub.open(client);
    client.on('pong', () => this.hub.onPong(client));
  }

  handleDisconnect(client: WebSocket): void {
    this.hub.remove(client);
  }

  @SubscribeMessage('auth')
  async auth(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const token =
      typeof body === 'object' && body !== null
        ? (body as { token?: unknown }).token
        : undefined;
    await this.hub.authenticate(client, token);
  }
}
