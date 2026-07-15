import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@libs/prisma';
import { createHash } from 'crypto';
import { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const rawKey = request.headers['x-api-key'];

    if (!rawKey || typeof rawKey !== 'string') {
      throw new UnauthorizedException({
        code: 'API_KEY_MISSING',
        message: 'X-Api-Key header is required',
      });
    }

    const pepper = this.config.getOrThrow<string>('API_KEY_PEPPER');
    const hashedKey = createHash('sha256').update(rawKey + pepper).digest('hex');

    const apiKey = await this.prisma.apiKey.findUnique({ where: { hashedKey } });
    if (!apiKey || apiKey.revokedAt) {
      throw new UnauthorizedException({
        code: 'API_KEY_INVALID',
        message: 'Invalid or revoked API key',
      });
    }

    this.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    Object.assign(request, {
      merchant: { id: apiKey.merchantId },
      apiKeyScopes: apiKey.scopes,
    });

    return true;
  }
}
