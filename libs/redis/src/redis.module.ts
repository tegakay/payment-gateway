import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { RedisService } from './redis.service';
import { RedisLockService } from './redis-lock.service';
import { REDIS_CLIENT } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        return new Redis(config.getOrThrow<string>('REDIS_URL'));
      },
    },
    RedisService,
    RedisLockService,
  ],
  exports: [REDIS_CLIENT, RedisService, RedisLockService],
})
export class RedisModule {}
