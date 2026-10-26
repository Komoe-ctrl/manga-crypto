import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeBus } from './realtime-events.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeHub } from './realtime.hub.js';

/**
 * Temps réel vers le front. Global : les services métier injectent `RealtimeBus` (de façon facultative) pour publier
 * sans dépendre du WebSocket.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [RealtimeBus, RealtimeHub, RealtimeGateway],
  exports: [RealtimeBus],
})
export class RealtimeModule {}
