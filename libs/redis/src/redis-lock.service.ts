import { Injectable, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from './redis.constants';

@Injectable()
export class RedisLockService {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const lockValue = randomUUID();
    const result = await this.client.set(key, lockValue, 'PX', ttlMs, 'NX');
    return result === 'OK' ? lockValue : null;
  }

  async release(key: string, lockValue: string): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.client.eval(script, 1, key, lockValue) as number;
    return result === 1;
  }
}
