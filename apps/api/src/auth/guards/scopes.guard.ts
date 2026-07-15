import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ApiKeyScope } from '@libs/common';
import { REQUIRE_SCOPES_KEY } from '../decorators/require-scopes.decorator';

interface ScopedRequest extends Request {
  apiKeyScopes?: ApiKeyScope[];
}

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ApiKeyScope[] | undefined>(
      REQUIRE_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<ScopedRequest>();
    // No apiKeyScopes means the request authenticated via JWT (dashboard session), which has full access.
    const scopes = request.apiKeyScopes;
    if (!scopes) {
      return true;
    }

    const hasAll = required.every((scope) => scopes.includes(scope));
    if (!hasAll) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_SCOPE',
        message: `Missing required scope(s): ${required.join(', ')}`,
      });
    }
    return true;
  }
}
