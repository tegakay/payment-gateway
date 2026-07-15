import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@libs/prisma';
import { ApiKeyScope, QUEUE_NAMES } from '@libs/common';
import { createHash, randomBytes } from 'crypto';
import { ApiKeyCreatedDto, ApiKeyRotatedDto, ApiKeySummaryDto } from './dto/api-key.dto';

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(QUEUE_NAMES.API_KEY_REVOCATION) private readonly revocationQueue: Queue,
  ) {}

  async create(merchantId: string, scopes: ApiKeyScope[]): Promise<ApiKeyCreatedDto> {
    const { rawKey, keyPrefix, hashedKey } = this.generateKey();
    const apiKey = await this.prisma.apiKey.create({
      data: { merchantId, keyPrefix, hashedKey, scopes },
    });
    return {
      id: apiKey.id,
      keyPrefix: apiKey.keyPrefix,
      scopes: apiKey.scopes,
      lastUsedAt: apiKey.lastUsedAt,
      revokedAt: apiKey.revokedAt,
      createdAt: apiKey.createdAt,
      key: rawKey,
      shownOnce: true,
    };
  }

  async list(merchantId: string): Promise<ApiKeySummaryDto[]> {
    const keys = await this.prisma.apiKey.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((k) => ({
      id: k.id,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
    }));
  }

  async rotate(merchantId: string, keyId: string): Promise<ApiKeyRotatedDto> {
    const existing = await this.prisma.apiKey.findFirst({ where: { id: keyId, merchantId } });
    if (!existing) {
      throw new NotFoundException({ code: 'API_KEY_NOT_FOUND', message: 'API key not found' });
    }
    if (existing.revokedAt) {
      throw new ConflictException({ code: 'API_KEY_ALREADY_REVOKED', message: 'API key is already revoked' });
    }

    const { rawKey, keyPrefix, hashedKey } = this.generateKey();
    const newKey = await this.prisma.apiKey.create({
      data: { merchantId, keyPrefix, hashedKey, scopes: existing.scopes },
    });

    const graceMs = this.config.get<number>('API_KEY_ROTATION_GRACE_MS', 24 * 60 * 60 * 1000);
    await this.revocationQueue.add(
      'revoke',
      { apiKeyId: existing.id },
      { jobId: `revoke-api-key:${existing.id}`, delay: graceMs },
    );

    return {
      id: newKey.id,
      keyPrefix: newKey.keyPrefix,
      scopes: newKey.scopes,
      lastUsedAt: newKey.lastUsedAt,
      revokedAt: newKey.revokedAt,
      createdAt: newKey.createdAt,
      key: rawKey,
      shownOnce: true,
      previousKeyGraceExpiresAt: new Date(Date.now() + graceMs),
    };
  }

  async revoke(merchantId: string, keyId: string): Promise<void> {
    const existing = await this.prisma.apiKey.findFirst({ where: { id: keyId, merchantId } });
    if (!existing) {
      throw new NotFoundException({ code: 'API_KEY_NOT_FOUND', message: 'API key not found' });
    }
    if (existing.revokedAt) {
      return;
    }
    await this.prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  }

  private generateKey(): { rawKey: string; keyPrefix: string; hashedKey: string } {
    const rawKey = `pk_live_${randomBase62(43)}`;
    // "pk_live_" (8 chars) + first 8 chars of the random suffix, per implementation-plan example.
    const keyPrefix = rawKey.slice(0, 16);
    const pepper = this.config.getOrThrow<string>('API_KEY_PEPPER');
    const hashedKey = createHash('sha256').update(rawKey + pepper).digest('hex');
    return { rawKey, keyPrefix, hashedKey };
  }
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Largest multiple of 62 that fits in a byte, so byte % 62 stays uniform (rejection sampling avoids modulo bias).
const BASE62_REJECTION_THRESHOLD = 256 - (256 % BASE62_ALPHABET.length);

// 43 base62 chars ~= 256 bits of entropy (log2(62) * 43 ≈ 256), matching a 32-byte random key.
function randomBase62(length: number): string {
  let result = '';
  while (result.length < length) {
    for (const byte of randomBytes(length - result.length)) {
      if (byte < BASE62_REJECTION_THRESHOLD) {
        result += BASE62_ALPHABET[byte % BASE62_ALPHABET.length];
      }
    }
  }
  return result;
}
