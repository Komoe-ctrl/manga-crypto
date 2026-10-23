import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { ExchangesModule } from './exchanges/exchanges.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RiskModule } from './risk/risk.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Limite générale par IP ; les routes d'authentification sont plus strictes (@Throttle).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    CryptoModule,
    AuditModule,
    AuthModule,
    ExchangesModule,
    RiskModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Ordre : limitation de débit, puis authentification.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
