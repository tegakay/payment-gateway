import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@libs/common';
import { ApiKeyRevocationProcessor } from './api-key-revocation.processor';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_NAMES.API_KEY_REVOCATION })],
  providers: [ApiKeyRevocationProcessor],
})
export class ApiKeysWorkerModule {}
