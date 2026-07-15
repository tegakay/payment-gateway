import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@libs/prisma';
import { RedisService } from '@libs/redis';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: { merchant: { create: jest.Mock } };

  beforeEach(async () => {
    prisma = { merchant: { create: jest.fn() } };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jest.fn(), verifyAsync: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn(), getOrThrow: jest.fn().mockReturnValue('secret') } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: RedisService, useValue: { get: jest.fn(), set: jest.fn() } },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('rejects duplicate email with a 409 EMAIL_ALREADY_EXISTS', async () => {
    prisma.merchant.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.21.0',
      }),
    );

    await expect(
      service.signup({ email: 'dup@example.com', password: 'password123', businessName: 'Acme' }),
    ).rejects.toMatchObject({
      response: { code: 'EMAIL_ALREADY_EXISTS' },
    });
    await expect(
      service.signup({ email: 'dup@example.com', password: 'password123', businessName: 'Acme' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never includes the password hash in the returned merchant profile', async () => {
    prisma.merchant.create.mockResolvedValue({
      id: 'merchant-1',
      email: 'clean@example.com',
      passwordHash: '$2b$12$shouldneverleak',
      businessName: 'Acme',
      status: 'ACTIVE',
      balanceCents: 0n,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const profile = await service.signup({
      email: 'clean@example.com',
      password: 'password123',
      businessName: 'Acme',
    });

    expect(profile).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(profile)).not.toContain('shouldneverleak');
  });
});
