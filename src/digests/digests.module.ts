import { Module } from '@nestjs/common';
import { DigestsController } from './digests.controller.js';
import { DigestsService } from './digests.service.js';

/** API de consultation des rapports du matin. Leur génération est assurée par `DigestEngineModule`. */
@Module({
  controllers: [DigestsController],
  providers: [DigestsService],
  exports: [DigestsService],
})
export class DigestsModule {}
