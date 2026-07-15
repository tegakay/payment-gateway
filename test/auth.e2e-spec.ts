import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { createHash } from 'crypto';
import { AppModule } from '../apps/api/src/app.module';
import { PrismaService } from '../libs/prisma/src/prisma.service';
import { RedisService } from '../libs/redis/src/redis.service';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  const uniqueEmail = (label: string): string => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('completes the signup -> login -> protected route -> refresh -> logout lifecycle', async () => {
    const email = uniqueEmail('lifecycle');
    const password = 'correct-horse-battery-staple';

    const signupRes = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password, businessName: 'Acme Corp' })
      .expect(201);

    expect(signupRes.body.email).toBe(email);
    expect(signupRes.body.passwordHash).toBeUndefined();

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    expect(loginRes.body.accessToken).toEqual(expect.any(String));
    expect(loginRes.body.refreshToken).toEqual(expect.any(String));

    const { accessToken, refreshToken } = loginRes.body;

    await request(app.getHttpServer())
      .get('/merchants/me/api-keys')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    const rotatedRefreshToken = refreshRes.body.refreshToken;
    expect(rotatedRefreshToken).not.toBe(refreshToken);

    await request(app.getHttpServer()).post('/auth/logout').send({ refreshToken: rotatedRefreshToken }).expect(204);

    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: rotatedRefreshToken }).expect(401);
  });

  it('rejects duplicate signup with 409', async () => {
    const email = uniqueEmail('dup');
    const payload = { email, password: 'correct-horse-battery-staple', businessName: 'Acme Corp' };

    await request(app.getHttpServer()).post('/auth/signup').send(payload).expect(201);
    const res = await request(app.getHttpServer()).post('/auth/signup').send(payload).expect(409);

    expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('serves the cached pair on an immediate retry with the same stale token', async () => {
    const email = uniqueEmail('retry');
    const password = 'correct-horse-battery-staple';
    await request(app.getHttpServer()).post('/auth/signup').send({ email, password, businessName: 'Acme Corp' }).expect(201);

    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    const firstRefreshToken = loginRes.body.refreshToken;

    const firstRotation = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefreshToken })
      .expect(200);

    // An immediate retry with the now-revoked token (simulating a network-drop retry)
    // is served the cached response rather than triggering the reuse cascade.
    const retryRotation = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefreshToken })
      .expect(200);

    expect(retryRotation.body.refreshToken).toBe(firstRotation.body.refreshToken);
  });

  it('cascade-revokes the entire chain when a revoked refresh token is reused outside the replay window', async () => {
    const email = uniqueEmail('reuse');
    const password = 'correct-horse-battery-staple';
    await request(app.getHttpServer()).post('/auth/signup').send({ email, password, businessName: 'Acme Corp' }).expect(201);

    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    const firstRefreshToken = loginRes.body.refreshToken;

    const secondRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefreshToken })
      .expect(200);
    const secondRefreshToken = secondRes.body.refreshToken;

    // Simulate the 60s replay-cache window elapsing so the next reuse is treated as genuine theft.
    const firstTokenHash = createHash('sha256').update(firstRefreshToken).digest('hex');
    await redis.del(`refresh_replay:${firstTokenHash}`);

    const reuseRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefreshToken })
      .expect(401);
    expect(reuseRes.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The cascade must also revoke the still-unexpired descendant token.
    await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: secondRefreshToken }).expect(401);

    const merchant = await prisma.merchant.findUnique({ where: { email } });
    const tokens = await prisma.refreshToken.findMany({ where: { merchantId: merchant!.id } });
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('fires exactly one 201 and the rest 409 under 20 concurrent signups with the same email', async () => {
    const email = uniqueEmail('concurrent');
    const payload = { email, password: 'correct-horse-battery-staple', businessName: 'Acme Corp' };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => request(app.getHttpServer()).post('/auth/signup').send(payload)),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
  });

  it('never returns hashedKey or raw key material from the list endpoint', async () => {
    const email = uniqueEmail('apikeys');
    const password = 'correct-horse-battery-staple';
    await request(app.getHttpServer()).post('/auth/signup').send({ email, password, businessName: 'Acme Corp' }).expect(201);
    const loginRes = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    const { accessToken } = loginRes.body;

    const createRes = await request(app.getHttpServer())
      .post('/merchants/me/api-keys')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ scopes: ['payments:read'] })
      .expect(201);

    expect(createRes.body.key).toMatch(/^pk_live_/);
    expect(createRes.body.shownOnce).toBe(true);

    const listRes = await request(app.getHttpServer())
      .get('/merchants/me/api-keys')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    for (const key of listRes.body) {
      expect(key.hashedKey).toBeUndefined();
      expect(key.key).toBeUndefined();
    }
  });
});
