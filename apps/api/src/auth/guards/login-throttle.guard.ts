import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '@libs/redis';
import { Request } from 'express';

const LIMIT = 5;
const WINDOW_SECONDS = 60;

@Injectable()
export class LoginThrottleGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const email = typeof request.body?.email === 'string' ? request.body.email.toLowerCase() : 'unknown';
    const key = `throttle:login:${request.ip}:${email}`;

    const client = this.redis.getClient();
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, WINDOW_SECONDS);
    }

    if (count > LIMIT) {
      throw new HttpException(
        { code: 'TOO_MANY_LOGIN_ATTEMPTS', message: 'Too many login attempts, try again later' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
