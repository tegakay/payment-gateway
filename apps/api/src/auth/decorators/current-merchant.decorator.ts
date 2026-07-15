import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { ApiKeyScope } from '@libs/common';
import { AuthenticatedUser } from '../strategies/jwt-access.strategy';

export interface CurrentMerchantPayload {
  id: string;
  /** null means the request authenticated via JWT dashboard session, which has full access. */
  scopes: ApiKeyScope[] | null;
  authMethod: 'jwt' | 'api_key';
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  merchant?: { id: string };
  apiKeyScopes?: ApiKeyScope[];
}

export const CurrentMerchant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentMerchantPayload => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.merchant && request.apiKeyScopes) {
      return { id: request.merchant.id, scopes: request.apiKeyScopes, authMethod: 'api_key' };
    }
    if (request.user?.merchantId) {
      return { id: request.user.merchantId, scopes: null, authMethod: 'jwt' };
    }
    throw new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'No authenticated merchant on request',
    });
  },
);
