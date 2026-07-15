import { SetMetadata } from '@nestjs/common';
import { ApiKeyScope } from '@libs/common';

export const REQUIRE_SCOPES_KEY = 'requireScopes';

export const RequireScopes = (...scopes: ApiKeyScope[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_SCOPES_KEY, scopes);
