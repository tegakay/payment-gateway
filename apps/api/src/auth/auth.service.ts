import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@libs/prisma';
import { RedisService } from '@libs/redis';
import { Merchant, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { MerchantProfileDto, TokenPairDto } from './dto/merchant-profile.dto';
import { AccessTokenPayload, RefreshTokenPayload } from './types/jwt-payload.type';

const BCRYPT_COST = 12;
const REFRESH_REPLAY_CACHE_TTL_SECONDS = 60;
// A valid bcrypt hash of a value nobody can supply as a password, used to keep login's bcrypt.compare
// cost constant whether or not the merchant exists — avoids leaking account existence via timing.
const DUMMY_PASSWORD_HASH = '$2b$12$7Ost46p6A9jGM7VmLLiZOuAh0cGx2MSDqBiAPdElftkUBranVVYN2';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly redis: RedisService,
  ) {}

  async signup(dto: SignupDto): Promise<MerchantProfileDto> {
    const email = dto.email.toLowerCase();
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    let merchant: Merchant;
    try {
      merchant = await this.prisma.merchant.create({
        data: { email, passwordHash, businessName: dto.businessName },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'An account with this email already exists',
        });
      }
      throw err;
    }

    this.eventEmitter.emit('merchant.created', { merchantId: merchant.id, email: merchant.email });

    return this.toMerchantProfile(merchant);
  }

  async login(dto: LoginDto): Promise<TokenPairDto> {
    const merchant = await this.prisma.merchant.findUnique({ where: { email: dto.email.toLowerCase() } });
    // Always run bcrypt.compare, even for a nonexistent merchant, so response time doesn't
    // leak whether the email is registered.
    const passwordMatches = await bcrypt.compare(dto.password, merchant?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!merchant || !passwordMatches) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }
    if (merchant.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'MERCHANT_NOT_ACTIVE',
        message: 'Merchant account is not active',
      });
    }

    return this.issueTokenPair(merchant.id);
  }

  async refresh(rawToken: string): Promise<TokenPairDto> {
    const payload = await this.verifyRefreshToken(rawToken);
    const tokenHash = this.hashToken(rawToken);

    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Refresh token not recognized',
      });
    }

    if (existing.revokedAt) {
      const cached = await this.redis.get(this.replayCacheKey(tokenHash));
      if (cached) {
        return JSON.parse(cached) as TokenPairDto;
      }
      await this.prisma.refreshToken.updateMany({
        where: { merchantId: existing.merchantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REUSED',
        message: 'Refresh token reuse detected; all sessions have been revoked',
      });
    }

    if (existing.expiresAt < new Date()) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired',
      });
    }

    const merchant = await this.prisma.merchant.findUnique({ where: { id: existing.merchantId } });
    if (!merchant || merchant.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'MERCHANT_NOT_ACTIVE',
        message: 'Merchant account is not active',
      });
    }

    if (payload.merchantId !== merchant.id) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Refresh token does not match merchant',
      });
    }

    const accessToken = await this.signAccessToken(merchant.id);
    const { rawRefreshToken, tokenHash: newTokenHash, expiresAt } = await this.buildRefreshToken(merchant.id);

    try {
      await this.prisma.$transaction(async (tx) => {
        const newRow = await tx.refreshToken.create({
          data: { merchantId: merchant.id, tokenHash: newTokenHash, expiresAt },
        });
        // Conditional on revokedAt still being null: if a concurrent request already rotated
        // this exact token between our lookup and here, this affects zero rows. Throwing here
        // rolls back newRow too, instead of leaving an orphaned, chain-less refresh token.
        const result = await tx.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { revokedAt: new Date(), replacedById: newRow.id },
        });
        if (result.count !== 1) {
          throw new ConcurrentRotationError();
        }
      });
    } catch (err) {
      if (err instanceof ConcurrentRotationError) {
        throw new UnauthorizedException({
          code: 'REFRESH_TOKEN_INVALID',
          message: 'Refresh token was already rotated by a concurrent request',
        });
      }
      throw err;
    }

    const tokenPair = this.toTokenPair(accessToken, rawRefreshToken);
    await this.redis.set(this.replayCacheKey(tokenHash), JSON.stringify(tokenPair), REFRESH_REPLAY_CACHE_TTL_SECONDS);
    return tokenPair;
  }

  async logout(rawToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokenPair(merchantId: string): Promise<TokenPairDto> {
    const accessToken = await this.signAccessToken(merchantId);
    const { rawRefreshToken, tokenHash, expiresAt } = await this.buildRefreshToken(merchantId);

    await this.prisma.refreshToken.create({
      data: { merchantId, tokenHash, expiresAt },
    });

    return this.toTokenPair(accessToken, rawRefreshToken);
  }

  private async signAccessToken(merchantId: string): Promise<string> {
    const payload: AccessTokenPayload = { sub: merchantId, merchantId, type: 'access' };
    return this.jwtService.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.accessTtlSeconds(),
      audience: 'merchant',
    });
  }

  private async buildRefreshToken(
    merchantId: string,
  ): Promise<{ rawRefreshToken: string; tokenHash: string; expiresAt: Date }> {
    const ttlSeconds = parseDurationToSeconds(this.config.get<string>('JWT_REFRESH_TTL', '7d'));
    const payload: RefreshTokenPayload = {
      sub: merchantId,
      merchantId,
      type: 'refresh',
      jti: randomUUID(),
    };
    const rawRefreshToken = await this.jwtService.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: ttlSeconds,
      audience: 'merchant',
    });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return { rawRefreshToken, tokenHash: this.hashToken(rawRefreshToken), expiresAt };
  }

  private accessTtlSeconds(): number {
    return parseDurationToSeconds(this.config.get<string>('JWT_ACCESS_TTL', '15m'));
  }

  private async verifyRefreshToken(rawToken: string): Promise<RefreshTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(rawToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        audience: 'merchant',
      });
      if (payload.type !== 'refresh') {
        throw new Error('not a refresh token');
      }
      return payload;
    } catch {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Refresh token is invalid or expired',
      });
    }
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private replayCacheKey(tokenHash: string): string {
    return `refresh_replay:${tokenHash}`;
  }

  private toTokenPair(accessToken: string, refreshToken: string): TokenPairDto {
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds(),
    };
  }

  private toMerchantProfile(merchant: Merchant): MerchantProfileDto {
    return {
      id: merchant.id,
      email: merchant.email,
      businessName: merchant.businessName,
      status: merchant.status,
      createdAt: merchant.createdAt,
    };
  }
}

class ConcurrentRotationError extends Error {}

function parseDurationToSeconds(duration: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    const asNumber = Number(duration);
    if (Number.isFinite(asNumber)) return asNumber;
    throw new Error(`Invalid duration: ${duration}`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * multipliers[unit];
}
