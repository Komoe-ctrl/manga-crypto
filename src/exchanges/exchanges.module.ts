import { Module } from '@nestjs/common';
import { ExchangesController } from './exchanges.controller.js';
import { ExchangesService } from './exchanges.service.js';
import { BinanceVerifier } from './verification/binance.verifier.js';
import { VerifierRegistry } from './verification/verifier.registry.js';

@Module({
  controllers: [ExchangesController],
  providers: [ExchangesService, BinanceVerifier, VerifierRegistry],
  exports: [ExchangesService],
})
export class ExchangesModule {}
