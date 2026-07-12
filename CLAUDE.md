# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Payment Gateway Simulator** — a production-grade NestJS API that mimics a real payment gateway (Stripe-like). The full implementation plan lives in `payment-gateway-simulator-implementation-plan.md`. No code exists yet; this CLAUDE.md will evolve as the project is built.

**Stack:** NestJS (TypeScript, strict mode) · PostgreSQL 16 + Prisma · Redis 7 · BullMQ · JWT/Refresh tokens · MinIO/S3 · Jest + Supertest · Swagger · Docker Compose

## Development Commands

```bash
# Start all infrastructure (Postgres, Redis, MinIO, API, Worker)
docker compose up

# Run migrations against the real database
npx prisma migrate deploy

# Reset DB and re-run all migrations (dev only)
npx prisma migrate reset --force

# Check for migration drift (also run as pre-commit hook)
npx prisma migrate diff

# Typecheck only (no emit)
npx tsc --noEmit

# Lint
npx eslint .

# Run all tests
npx jest

# Run a single test file
npx jest path/to/spec.ts

# Run only concurrency/chaos tests (tagged @concurrency)
npx jest --testNamePattern="@concurrency"

# Run E2E tests
npx jest --config jest-e2e.config.ts
```

## Monorepo Layout

```
apps/api/          — single HTTP process (NestJS app)
apps/worker/       — BullMQ worker (same codebase, PROCESS_TYPE=worker env flag)
libs/common/       — shared DTOs, decorators, guards
libs/prisma/       — global PrismaModule wrapping PrismaClient
libs/redis/        — global RedisModule (ioredis); separate connection for BullMQ
libs/ledger/       — LedgerService (double-entry posting)
libs/idempotency/  — IdempotencyInterceptor (Redis-backed)
libs/webhooks/     — WebhookDispatcherService + BullMQ processor
```

## Core Architectural Rules

### Money & Ledger
- **All monetary values are `BigInt` minor units (cents).** Never `Float`/`Decimal`.
- **`LedgerEntry` is the source of truth for balance**, not `Merchant.balanceCents`. The balance field is a denormalized read-cache only — it is updated synchronously in the same transaction as the ledger write.
- `LedgerService.postDoubleEntry()` must be called **from within an existing Prisma transaction** (the `tx` param is required). It never opens its own transaction.
- Every `transactionGroupId` must balance: `SUM(debits) === SUM(credits)`. Verified both at service layer and by a nightly BullMQ reconciliation job.
- `LedgerEntry` rows are **append-only** — no `updatedAt`, never mutated.

### Idempotency
- `IdempotencyInterceptor` (Redis `SET NX`) is applied **only** to state-changing financial endpoints: create payment intent, capture, cancel, refund. Not global.
- Redis key pattern: `idem:{merchantId}:{idempotencyKey}`
- On handler failure, the interceptor **deletes** the `IN_PROGRESS` key (not marks it failed), so the next retry is treated as fresh.
- If Redis is down, the interceptor **fails closed** — returns `503` rather than allowing an unprotected financial write.

### Concurrency Control (Capture & Refund)
- Every capture/refund runs inside a **Serializable transaction** with `SELECT ... FOR UPDATE` on the payment intent row (belt-and-suspenders: SSI catches logical anomalies, `FOR UPDATE` prevents unnecessary retries under contention).
- A **Redis `SET NX` fast-fail lock** (`lock:capture:{intentId}`, TTL 5s) is an optimization only — it short-circuits obvious double-clicks before hitting Postgres. The DB lock is the correctness guarantee.
- `P2034` (Postgres serialization failure) is caught and retried up to 3× with jittered backoff before surfacing a `409`.

### Payment Intent State Machine
- Valid transitions are encoded in a single `TRANSITIONS` table in `PaymentIntentStateMachine` — not scattered `if` statements.
- Every transition uses **optimistic locking** (`version` column): `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`. Zero-row update → `409`.
- All state changes emit domain events via `EventEmitter2` (`payment_intent.succeeded`, etc.) consumed by the Webhooks module — the state machine never calls the webhook dispatcher directly.

### Authentication
- Two completely separate auth identities: `Merchant` (JWT audience `merchant`) and `AdminUser` (JWT audience `admin`). An admin token must never work on merchant-scoped endpoints.
- API keys: stored as `SHA-256(rawKey + API_KEY_PEPPER)` only. Raw key returned exactly once at creation. Prefix (first 8 chars) shown in dashboard.
- Refresh token rotation: old token's `replacedById` chain enables reuse detection. A revoked token presented again → cascade-revoke the entire chain.
- Rotation response cached in Redis for 60s (keyed by old token hash) to prevent false-positive theft detection on immediate network-retry.

### BullMQ / Side Effects
- No request handler ever calls an external system synchronously.
- BullMQ requires a **dedicated Redis connection** — never share with the ioredis client used for cache/idempotency.
- Worker runs as a separate container via `PROCESS_TYPE=worker` env flag, same codebase.
- Webhook delivery uses `jobId: webhook:{endpointId}:{paymentIntentEventId}` for BullMQ-level deduplication.

### Error Response Envelope
All errors return:
```json
{ "error": { "code": "MACHINE_READABLE_ENUM", "message": "...", "requestId": "..." } }
```
`code` is stable for SDK consumption (e.g., `INSUFFICIENT_FUNDS`, `INTENT_NOT_CAPTURABLE`, `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`).

## Key Testing Rules

- E2E tests use **real Postgres and Redis** (Testcontainers or `docker-compose.test.yml`). No mocking the database.
- `prisma migrate reset --force` between test suites (not between individual tests). Per-test isolation uses transaction rollback, **except** concurrency tests which need multiple real connections.
- Concurrency tests (tagged `@concurrency`) fire real parallel requests via `Promise.all` + Supertest against a live app instance.
- Coverage threshold ≥85% branch coverage on `libs/ledger`, `libs/idempotency`, and the payment-intent state machine — enforced via `jest.config.ts` `coverageThreshold`.
- BullMQ queues in tests: use real Redis + `await queueEvents` completion; no `sleep()`.

## Environment Variables (required at boot, validated via Joi)

```
DATABASE_URL, SHADOW_DATABASE_URL, REDIS_URL,
JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, JWT_ACCESS_TTL, JWT_REFRESH_TTL,
S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY,
WEBHOOK_SIGNING_SECRET_PEPPER, API_KEY_PEPPER
```

## Implementation Phases (reference)

| Phase | Feature |
|-------|---------|
| 0 | Infrastructure, Docker Compose, Prisma, global modules, health checks |
| 1 | Merchant auth, JWT, refresh tokens, API keys, scopes |
| 2 | Payment intents, state machine, BullMQ processing simulation |
| 3 | Authorize/capture flow, Redis + DB concurrency control |
| 4 | Double-entry ledger, refunds, MinIO statement exports |
| 5 | Idempotency interceptor (Redis-backed) |
| 6 | Webhook dispatch, HMAC signing, BullMQ retries/backoff |
| 7 | Admin dashboard, failure simulation config, RBAC |
