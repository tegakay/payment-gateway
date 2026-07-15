import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from '@libs/prisma';
import { RedisModule } from '@libs/redis';
import { envValidationSchema } from '@libs/common';
import { ApiKeysWorkerModule } from './api-keys/api-keys-worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    PrismaModule,
    RedisModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = new URL(config.getOrThrow<string>('REDIS_URL'));
        return {
          connection: {
            host: redisUrl.hostname,
            port: parseInt(redisUrl.port || '6379', 10),
            password: redisUrl.password || undefined,
          },
        };
      },
    }),
    EventEmitterModule.forRoot(),
    ApiKeysWorkerModule,
  ],
})
export class WorkerModule {}
