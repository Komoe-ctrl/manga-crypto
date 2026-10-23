import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service.js';

/** Expose EncryptionService à toute l'application (le module d'échanges en aura besoin, ainsi que l'audit). */
@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class CryptoModule {}
