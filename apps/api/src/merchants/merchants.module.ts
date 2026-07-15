import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@libs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: QUEUE_NAMES.API_KEY_REVOCATION })],
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
})
export class MerchantsModule {}
