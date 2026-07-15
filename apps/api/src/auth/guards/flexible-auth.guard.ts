import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { firstValueFrom, isObservable } from 'rxjs';
import { ApiKeyGuard } from './api-key.guard';
import { JwtAccessGuard } from './jwt-access.guard';

@Injectable()
export class FlexibleAuthGuard implements CanActivate {
  constructor(
    private readonly apiKeyGuard: ApiKeyGuard,
    private readonly jwtGuard: JwtAccessGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (request.headers['x-api-key']) {
      return this.apiKeyGuard.canActivate(context);
    }

    const result = this.jwtGuard.canActivate(context);
    return isObservable(result) ? firstValueFrom(result) : result;
  }
}
