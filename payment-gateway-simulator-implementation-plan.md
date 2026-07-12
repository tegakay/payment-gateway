

# Payment Gateway Simulator — Production Implementation Plan

**Stack:** NestJS (TypeScript) · PostgreSQL + Prisma · Redis · BullMQ · JWT/Refresh · MinIO/S3 · Jest/Supertest · Swagger · Docker Compose

## Guiding Architectural Principles

1. **Money never moves without a ledger entry.** No field on `PaymentIntent` is ever treated as the source of truth for balance — the ledger is.
2. **Every state-changing HTTP endpoint is idempotent by construction**, not by convention.
3. **Concurrency correctness is enforced at the database**, not the application layer — row locks and unique constraints do the real work; Redis locks are a fast-fail optimization, not the safety mechanism.
4. **Side effects (webhooks, PDF generation) are decoupled via BullMQ.** No request handler ever calls an external system synchronously.
5. **All monetary values are stored as `BigInt` minor units (cents)** — never `Float`/`Decimal` drift.

---

## Phase 0: Infrastructure & Repository Scaffolding

### 1. Architectural & Database Schema Design
- Monorepo layout (Nest CLI monorepo mode) with a single deployable `apps/api`, shared `libs/common` (DTOs, decorators, guards), `libs/ledger`, `libs/webhooks`.
- `docker-compose.yml` services: `postgres:16`, `redis:7`, `minio/minio`, `api` (Dockerfile multi-stage: `deps` → `build` → `runtime` distroless-node image), `worker` (separate container running the same codebase in BullMQ-worker mode via `PROCESS_TYPE=worker` env flag — isolates webhook/PDF processing from the HTTP process for independent scaling).
- `.env` schema validated at boot via `@nestjs/config` + `Joi`:
  ```
  DATABASE_URL, SHADOW_DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET,
  JWT_ACCESS_TTL, JWT_REFRESH_TTL, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY,
  WEBHOOK_SIGNING_SECRET_PEPPER, API_KEY_PEPPER
  ```
- Prisma: `previewFeatures = ["postgresqlExtensions"]`, enable `pgcrypto` extension for `gen_random_uuid()`. All PKs are UUIDv4 (`@default(dbgenerated("gen_random_uuid()"))` or `cuid()` — UUID chosen for external-facing IDs to avoid enumeration).
- Base `schema.prisma` datasource:
  ```prisma
  datasource db {
    provider   = "postgresql"
    url        = env("DATABASE_URL")
    extensions = [pgcrypto]
  }
  generator client {
    provider        = "prisma-client-js"
    previewFeatures = ["postgresqlExtensions", "metrics"]
  }
  ```

### 2. Step-by-Step Implementation Steps
1. `nest new api --strict`, convert to monorepo, add `libs/common`, `libs/prisma`, `libs/redis`, `libs/ledger`, `libs/webhooks`, `libs/idempotency`.
2. `PrismaModule` as a **global dynamic module** wrapping `PrismaClient`, with `enableShutdownHooks` calling `app.close()` on SIGTERM for graceful drain.
3. `RedisModule` (global) wrapping `ioredis` — expose one client for cache/idempotency reads and a **separate dedicated connection** for BullMQ (BullMQ requires blocking commands; never share a client instance between them).
4. Root `AppModule` imports `ConfigModule.forRoot({ isGlobal: true, validationSchema })`, `PrismaModule`, `RedisModule`, `BullModule.forRootAsync` (registers Redis connection), `ThrottlerModule` (basic rate limiting, defense in depth alongside idempotency).
5. Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
6. Global `HttpExceptionFilter` normalizing errors into a stable envelope: `{ error: { code, message, requestId } }` — `code` is a stable machine-readable enum (`INSUFFICIENT_FUNDS`, `INTENT_NOT_CAPTURABLE`, etc.) consumed by SDKs.
7. Correlation-ID middleware: generates/propagates `X-Request-Id`, attached to logger context (`nestjs-pino` recommended over default logger for structured JSON logs shippable to any aggregator).
8. Swagger bootstrap at `/docs` with `DocumentBuilder().addBearerAuth()` + `addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'api-key')`; tag modules cleanly (`Merchants`, `PaymentIntents`, `Refunds`, `Webhooks`, `Admin`).

### 3. Idempotency & Resiliency Strategy
- Not yet feature-active in Phase 0, but the **wiring** goes in now: reserve `libs/idempotency` module skeleton and the Redis connection pool sizing (separate pool from BullMQ) so later phases don't need infra rework.
- Health checks (`@nestjs/terminus`) for Postgres, Redis, MinIO exposed at `/health` — required before any orchestrator (k8s/Compose healthcheck) routes traffic to the container.

### 4. Testing & Verification Plan
- `docker compose up` smoke test: assert all 5 containers reach `healthy`.
- Jest E2E bootstrap test: spin up `Test.createTestingModule`, hit `/health`, assert `200` with all indicators `up`.
- Verify Prisma migration commands run cleanly against a disposable `shadow` database in CI (`prisma migrate diff` in a pre-commit hook to catch drift).
- Lint/typecheck gates in CI (`eslint`, `tsc --noEmit`) block merge before any business-logic phase begins.

---

## Phase 1: Merchant Identity, Auth & API Keys

### 1. Architectural & Database Schema Design
```prisma
model Merchant {
  id            String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email         String    @unique
  passwordHash  String
  businessName  String
  status        MerchantStatus @default(ACTIVE)
  balanceCents  BigInt    @default(0) // DENORMALIZED cache only — never authoritative, see Phase 4
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  apiKeys       ApiKey[]
  refreshTokens RefreshToken[]
  paymentIntents PaymentIntent[]
  webhookEndpoints WebhookEndpoint[]

  @@index([status])
}

enum MerchantStatus { ACTIVE SUSPENDED DEACTIVATED }

model ApiKey {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  merchantId  String   @db.Uuid
  merchant    Merchant @relation(fields: [merchantId], references: [id])
  keyPrefix   String   // first 8 chars shown in dashboard, e.g. "pk_live_a1b2c3d4"
  hashedKey   String   @unique // SHA-256(key + pepper), never reversible
  scopes      String[] // ["payments:write","refunds:write","payments:read"]
  lastUsedAt  DateTime?
  revokedAt   DateTime?
  createdAt   DateTime @default(now())

  @@index([merchantId])
  @@index([keyPrefix])
}

model RefreshToken {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  merchantId  String   @db.Uuid
  merchant    Merchant @relation(fields: [merchantId], references: [id])
  tokenHash   String   @unique // never store raw refresh token
  expiresAt   DateTime
  revokedAt   DateTime?
  replacedById String? @db.Uuid // rotation chain, detects token-reuse attacks
  createdAt   DateTime @default(now())

  @@index([merchantId])
}
```
- **API keys are never stored in plaintext.** Generate `pk_live_<32-byte-base62>`, hash with `SHA-256(rawKey + API_KEY_PEPPER)` before persisting; return the raw value to the client exactly once in the creation response.
- Refresh tokens use **rotation with reuse detection**: each refresh issues a new token and marks the old one's `replacedById`; if a *revoked* token is presented again, cascade-revoke the entire chain for that merchant (signals token theft).
- Unique constraint on `Merchant.email` and `ApiKey.hashedKey` enforced at DB level, not just service-level checks, to close TOCTOU races on concurrent signups.

### 2. Step-by-Step Implementation Steps
- **`AuthModule`**
  - `POST /auth/signup` → `AuthService.signup()`: `bcrypt.hash(password, 12)`, wrapped in `prisma.$transaction` to create `Merchant` + emit a `merchant.created` internal event (for a future welcome-email worker).
  - `POST /auth/login` → validate via `bcrypt.compare`, issue access JWT (`sub`, `merchantId`, `type: 'access'`, 15 min TTL) + refresh JWT persisted as hashed row (7 day TTL).
  - `POST /auth/refresh` → `JwtRefreshGuard` validates signature + expiry, then service looks up `tokenHash`, checks `revokedAt IS NULL`; on success, rotates (revoke old, insert new) inside a transaction.
  - `POST /auth/logout` → revoke the specific refresh token row.
- **Guards**
  - `JwtAccessGuard` (Passport `jwt` strategy) for dashboard endpoints.
  - `ApiKeyGuard` (custom `CanActivate`): extracts `X-Api-Key` header, computes SHA-256 with pepper, looks up `ApiKey` by `hashedKey` (indexed, O(1)), verifies `revokedAt IS NULL`, attaches `request.merchant` and `request.apiKeyScopes`.
  - `ScopesGuard` + `@RequireScopes('payments:write')` decorator using `Reflector`, composed after `ApiKeyGuard` to enforce least-privilege per key.
  - A combined `AuthGuard` can accept **either** JWT or API key (`@UseGuards(FlexibleAuthGuard)`) for endpoints usable from both dashboard and server-to-server integrations.
- **`ApiKeyController`**
  - `POST /merchants/me/api-keys` → generates key, persists hash, returns raw key once with a response banner flag `shownOnce: true`.
  - `POST /merchants/me/api-keys/:id/rotate` → revokes old key (`revokedAt = now()`) and issues a new one in the same transaction — old key remains valid for a **grace window** (configurable, e.g., 24h) by only soft-revoking after the grace period via a scheduled BullMQ delayed job (`revoke-api-key` job with `delay`), so callers using the old key don't break mid-rotation.
  - `DELETE /merchants/me/api-keys/:id` → immediate hard revoke.
- Redis is used here only for **login rate limiting** (`ThrottlerGuard` with Redis storage adapter) to blunt credential-stuffing.

### 3. Idempotency & Resiliency Strategy
- Signup/login are naturally idempotent-ish (unique email constraint prevents duplicate accounts), so the formal `Idempotency-Key` interceptor is **not required here** — it's reserved for state-changing financial endpoints (Phase 5). This phase documents the exception explicitly so later engineers don't assume blanket coverage.
- Refresh-token rotation is itself a resiliency mechanism: if the network drops after the server rotates but before the client receives the new token, the client retries with the now-revoked old token → triggers the reuse-detection cascade. **Mitigation:** the rotation response is cached in Redis for a short TTL (60s) keyed by the *old token's hash*, so an immediate retry with the same stale token returns the previously-issued new pair instead of triggering a false-positive theft cascade.

### 4. Testing & Verification Plan
- Unit: `AuthService.signup` rejects duplicate email with `409`; password hash never present in any serialized DTO (assert via `class-transformer` `@Exclude()` on `passwordHash`).
- E2E (Supertest): full signup → login → protected-route → refresh → logout lifecycle.
- E2E: reused revoked refresh token → all descendant tokens in the chain are revoked; subsequent refresh attempts with any token in the chain return `401`.
- E2E: API key created → raw key works against a protected endpoint → key rotated → old key still works within grace window → after simulated grace-window job execution, old key returns `401`, new key succeeds.
- Concurrency test: fire 20 parallel signup requests with the same email; assert exactly one `201` and nineteen `409`s (validates DB unique constraint, not just app-level check).
- Security test: confirm `GET /merchants/me/api-keys` never returns `hashedKey` or the raw key in any response body.

---

## Phase 2: Payment Intents & State Machine

### 1. Architectural & Database Schema Design
```prisma
model PaymentIntent {
  id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  merchantId        String   @db.Uuid
  merchant          Merchant @relation(fields: [merchantId], references: [id])
  amountCents       BigInt
  amountCapturedCents BigInt @default(0)
  amountRefundedCents BigInt @default(0)
  currency          String   @db.Char(3)
  status            PaymentIntentStatus @default(CREATED)
  captureMethod     CaptureMethod @default(AUTOMATIC)
  paymentMethodSnapshot Json   // simulated card fingerprint/brand/last4 — never raw PAN
  failureCode       String?
  metadata          Json?
  version           Int      @default(0) // optimistic concurrency token
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  ledgerEntries     LedgerEntry[]
  refunds           Refund[]
  events            PaymentIntentEvent[]

  @@index([merchantId, status])
  @@index([status, createdAt])
}

enum PaymentIntentStatus {
  CREATED
  REQUIRES_ACTION
  PROCESSING
  REQUIRES_CAPTURE   // authorized, awaiting manual capture
  SUCCEEDED
  FAILED
  CANCELED
}

enum CaptureMethod { AUTOMATIC MANUAL }

model PaymentIntentEvent {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  paymentIntentId String   @db.Uuid
  paymentIntent   PaymentIntent @relation(fields: [paymentIntentId], references: [id])
  fromStatus      PaymentIntentStatus?
  toStatus        PaymentIntentStatus
  reason          String?
  createdAt       DateTime @default(now())

  @@index([paymentIntentId, createdAt])
}
```
- `PaymentIntentEvent` is an **append-only audit trail** of every transition — never mutated, only inserted. This is the forensic record used for support/dispute investigation and is distinct from the financial ledger (Phase 4).
- `version` column implements **optimistic locking**: every service-layer transition does `UPDATE ... SET status = ?, version = version + 1 WHERE id = ? AND version = ?`; a zero-row update means a concurrent transition won already occurred, and the service throws a `ConflictException` mapped to `409`.
- Valid transitions are enforced in **application code** via an explicit transition table (below), never inferred — this is deliberate: a state machine encoded as data (not scattered `if` statements) is the only way to keep Authorize/Capture/Refund logic auditable.

### 2. Step-by-Step Implementation Steps
- **`PaymentIntentsModule`**
  - `PaymentIntentStateMachine` (pure class, no DB access) holds:
    ```ts
    const TRANSITIONS: Record<PaymentIntentStatus, PaymentIntentStatus[]> = {
      CREATED: ['REQUIRES_ACTION', 'PROCESSING', 'CANCELED'],
      REQUIRES_ACTION: ['PROCESSING', 'CANCELED'],
      PROCESSING: ['REQUIRES_CAPTURE', 'SUCCEEDED', 'FAILED'],
      REQUIRES_CAPTURE: ['SUCCEEDED', 'CANCELED', 'FAILED'],
      SUCCEEDED: [],
      FAILED: [],
      CANCELED: [],
    };
    function assertTransition(from, to) { if (!TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to); }
    ```
  - `POST /payment-intents` → `PaymentIntentsService.create()`: validates `amountCents > 0`, currency in supported set, persists `CREATED` row + `PaymentIntentEvent(null → CREATED)` in one transaction. Simulated gateway processing is **not synchronous** — it's dispatched as a BullMQ job (`payment-processing` queue) to realistically emulate async settlement and to decouple HTTP latency from "bank" simulation latency.
  - A `PaymentProcessorProcessor` (BullMQ worker) picks up the job, simulates a probability-weighted outcome (configurable failure-injection rate for testing, see Phase 6 admin overrides), and calls `PaymentIntentsService.transition(id, nextStatus, { expectedVersion })`.
  - Every transition emits a domain event via `EventEmitter2` (`payment_intent.succeeded`, `.failed`, `.requires_action`) that the **Webhooks module** (Phase 6) subscribes to — this decouples the state machine from webhook dispatch entirely.
  - `GET /payment-intents/:id` and `GET /payment-intents` (paginated, filterable by status/date) for merchant dashboard and API consumers alike, guarded by `FlexibleAuthGuard` + ownership check (`merchantId` from token/key must match the intent's `merchantId` — enforced in a `PaymentIntentOwnershipGuard` to prevent IDOR).

### 3. Idempotency & Resiliency Strategy
- `POST /payment-intents` is the **first endpoint requiring the full `Idempotency-Key` interceptor** (built in Phase 5, but its contract is defined here): the same key + same merchant + same request body hash within a 24h window returns the original `201` response verbatim rather than creating a duplicate intent. This is critical because intent creation is the entry point most exposed to client-side network retries.
- BullMQ job for the processing simulation uses `jobId: paymentIntentId` — BullMQ deduplicates jobs with the same ID, so even if the create-handler is somehow invoked twice for the same intent (bug or replay), only one processing job is ever enqueued.
- Worker processing is itself retry-safe: on job failure (simulated transient error), BullMQ's built-in retry (`attempts: 3, backoff: { type: 'exponential', delay: 2000 }`) re-invokes the processor; the processor re-reads current DB status first and no-ops if already terminal (`SUCCEEDED`/`FAILED`), preventing double-transition from a stale retry.

### 4. Testing & Verification Plan
- Unit: state machine rejects all invalid transitions exhaustively (parametrized Jest test iterating the full status × status matrix).
- Unit: optimistic-lock conflict on simultaneous `transition()` calls with a stale `version` throws `409`.
- E2E: create intent → assert `CREATED` → simulate worker completion → poll until `SUCCEEDED` → assert exactly one `PaymentIntentEvent` row per transition, in order.
- E2E: two identical `POST /payment-intents` requests with the same `Idempotency-Key` → assert only one row exists in DB and both responses are byte-identical.
- Concurrency: use `Promise.all` to fire 10 concurrent `transition()` calls on the same intent from different terminal targets; assert exactly one succeeds and the rest 409.
- Ownership: merchant A cannot `GET` merchant B's intent (`403`/`404`, not leaking existence).

---

## Phase 3: Authorize/Capture Flow & Concurrency Control

### 1. Architectural & Database Schema Design
- Reuses `PaymentIntent.captureMethod` (`MANUAL`) and `REQUIRES_CAPTURE` status from Phase 2 — no new tables, but this phase is where **row-level locking becomes load-bearing**.
- Add a partial index to accelerate the admin/merchant "pending captures" queue:
  ```prisma
  @@index([merchantId, status], map: "idx_pending_captures") // filtered further at query time WHERE status = 'REQUIRES_CAPTURE'
  ```
- **Isolation strategy:** Capture and Refund both execute inside `prisma.$transaction(async (tx) => {...}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })`. Serializable is chosen over `READ COMMITTED` + manual locking because the capture path touches *two* aggregates (the intent row and the ledger) and Postgres's SSI (Serializable Snapshot Isolation) will abort-and-retry on any genuine write skew rather than requiring the developer to enumerate every lock manually.
- Within that transaction, the intent row is additionally fetched with `SELECT ... FOR UPDATE` (via `tx.$queryRaw`) as a **defense-in-depth** pessimistic lock — belt-and-suspenders: Serializable catches logical anomalies, `FOR UPDATE` prevents two transactions from even attempting a race in the first place, minimizing costly serialization-failure retries under high contention (e.g., double-capture-click from an impatient merchant).

### 2. Step-by-Step Implementation Steps
- `POST /payment-intents/:id/capture` (body: optional `amountCents` for partial capture) →
  1. **Redis fast-fail lock** (`libs/redis` `RedisLockService.acquire(`lock:capture:${intentId}`, ttlMs: 5000)` using `SET NX PX`) — if the lock is already held, immediately return `409 Conflict: capture already in progress` without ever touching Postgres. This is purely a UX/latency optimization to short-circuit obvious double-clicks before paying the cost of a DB round trip; it is **not** relied upon for correctness.
  2. Inside `try/finally`, open the Serializable transaction:
     - `SELECT * FROM "PaymentIntent" WHERE id = $1 FOR UPDATE`.
     - Assert `status === 'REQUIRES_CAPTURE'`; assert `requestedAmount <= amountCents - amountCapturedCents`.
     - Insert paired `LedgerEntry` rows (debit/credit — detailed in Phase 4) within the same transaction.
     - Update `amountCapturedCents`, transition status to `SUCCEEDED` (or remains `REQUIRES_CAPTURE` if a partial capture leaves a remainder and the gateway simulator supports multi-capture — configurable per merchant setting).
     - Insert `PaymentIntentEvent`.
  3. On `Prisma.PrismaClientKnownRequestError` with code `P2034` (serialization failure), catch and retry the transaction up to 3 times with jittered backoff before surfacing `409` to the caller — Postgres's SSI aborts are expected under contention and must be handled, not treated as fatal.
  4. Release the Redis lock in `finally`.
  5. Emit `payment_intent.succeeded` event → webhook queue (Phase 6).
- `POST /payment-intents/:id/cancel` (only valid from `CREATED`/`REQUIRES_CAPTURE`, e.g., merchant decides not to capture an authorization) follows the identical lock → transaction → transition pattern, releasing any held funds (ledger reversal entry, no actual money moved since capture never occurred).
- `CaptureAmountValidationPipe` (custom `PipeTransform`) rejects capture amounts exceeding the original authorization at the DTO layer before any DB call, for fast feedback.

### 3. Idempotency & Resiliency Strategy
- Capture is protected by **both** the general `Idempotency-Key` interceptor (Phase 5, prevents duplicate captures from network retries at the HTTP layer) **and** the Redis lock (prevents concurrent in-flight duplicate requests that arrive within milliseconds of each other, before the idempotency record would even be checked). These solve different failure modes: idempotency key = "same logical request replayed later"; Redis lock = "two near-simultaneous requests racing right now."
- If the Redis lock TTL expires while a transaction is still legitimately running (e.g., Postgres under load), the `FOR UPDATE` row lock still prevents a second concurrent transaction from proceeding — it will block on the row lock until the first transaction commits/rolls back, then see the already-updated status and reject cleanly. **The Redis lock is an optimization; the DB lock is the guarantee.**

### 4. Testing & Verification Plan
- **The canonical concurrency test for this entire system:** fire 50 concurrent `POST /:id/capture` requests (via `Promise.all` + Supertest against a running Nest app instance backed by real Postgres/Redis, not mocks) against a single `REQUIRES_CAPTURE` intent. Assert:
  - Exactly one request returns `200` with `SUCCEEDED`.
  - The remaining 49 return `409` (either from the Redis fast-fail or the post-lock status check).
  - Exactly one pair of `LedgerEntry` rows exists for the capture (query ledger table directly, assert count).
  - `amountCapturedCents` equals the requested amount exactly once, never double-applied.
- Partial capture: capture 40% of an authorization, assert intent remains capturable for the remainder (if multi-capture enabled) or transitions per configured policy.
- Serialization-failure retry test: inject an artificial delay/second competing transaction to force a Postgres `40001` serialization error, assert the service transparently retries and ultimately succeeds rather than surfacing the raw Postgres error to the client.
- Cancel-after-capture: assert `POST /:id/cancel` on a `SUCCEEDED` intent returns `409` (not a valid transition) — must go through Refund instead.
- Redis outage simulation: kill the Redis container mid-test, assert capture still functions correctly (degrades to DB-lock-only) — this proves the "belt and suspenders" claim rather than just asserting it in prose.

---

## Phase 4: Double-Entry Ledger & Refunds

### 1. Architectural & Database Schema Design
```prisma
model LedgerAccount {
  id           String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  merchantId   String?  @db.Uuid // null for platform-owned accounts (e.g., PLATFORM_REVENUE, PLATFORM_CLEARING)
  type         LedgerAccountType
  currency     String   @db.Char(3)
  createdAt    DateTime @default(now())

  @@unique([merchantId, type, currency])
}

enum LedgerAccountType {
  MERCHANT_AVAILABLE   // funds merchant can withdraw
  MERCHANT_PENDING     // captured but not yet settled/available
  PLATFORM_CLEARING    // simulated "bank" holding account, the other side of every customer charge
  PLATFORM_REVENUE     // simulated processing fees
}

model LedgerEntry {
  id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  transactionGroupId String  @db.Uuid // groups the debit+credit pair (and any N-way split) of one economic event
  accountId         String   @db.Uuid
  account           LedgerAccount @relation(fields: [accountId], references: [id])
  paymentIntentId   String?  @db.Uuid
  paymentIntent     PaymentIntent? @relation(fields: [paymentIntentId], references: [id])
  refundId          String?  @db.Uuid
  refund            Refund?  @relation(fields: [refundId], references: [id])
  direction         LedgerDirection // DEBIT | CREDIT
  amountCents       BigInt   // always positive; sign meaning comes from `direction`
  currency          String   @db.Char(3)
  entryType         LedgerEntryType
  createdAt         DateTime @default(now()) // IMMUTABLE — no updatedAt, this table is append-only

  @@index([accountId, createdAt])
  @@index([transactionGroupId])
  @@index([paymentIntentId])
}

enum LedgerDirection { DEBIT CREDIT }
enum LedgerEntryType { CAPTURE REFUND FEE ADJUSTMENT }
```
- **Invariant enforced at the service layer and verified by a nightly reconciliation job:** for every `transactionGroupId`, `SUM(debits) === SUM(credits)`. This is the double-entry guarantee. A Postgres `CHECK` constraint can't easily express a cross-row sum invariant, so it's enforced by (a) the service *only* ever inserting balanced groups within one transaction, and (b) a scheduled BullMQ **reconciliation job** that runs `GROUP BY transactionGroupId HAVING SUM(CASE WHEN direction='DEBIT' THEN amountCents ELSE -amountCents END) != 0` and pages an alert if any row is returned.
- `Merchant.balanceCents` (Phase 1) is a **read-through cache**, recomputed as `SUM(CREDIT) - SUM(DEBIT)` over `MERCHANT_AVAILABLE` entries, refreshed synchronously in the same transaction that writes new entries (`tx.merchant.update({ data: { balanceCents: { increment/decrement } } })`) — this keeps dashboard reads O(1) without a live aggregation query, while the `LedgerEntry` table remains the auditable source of truth used for any reconciliation or dispute.
- Refund model:
  ```prisma
  model Refund {
    id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    paymentIntentId   String   @db.Uuid
    paymentIntent     PaymentIntent @relation(fields: [paymentIntentId], references: [id])
    amountCents       BigInt
    reason            String?
    status            RefundStatus @default(SUCCEEDED) // simulator treats refunds as synchronous for simplicity; can be extended to PENDING
    version           Int      @default(0)
    createdAt         DateTime @default(now())

    ledgerEntries     LedgerEntry[]
    @@index([paymentIntentId])
  }
  enum RefundStatus { SUCCEEDED FAILED }
  ```

### 2. Step-by-Step Implementation Steps
- **`LedgerModule`** exposes a single injectable `LedgerService.postDoubleEntry({ groupId, entries: [{accountId, direction, amountCents, ...}] })` that:
  1. Asserts `entries.length >= 2` and `sum(debits) === sum(credits)` **before** touching the DB — a coding-error circuit breaker, not the real guarantee.
  2. Must be called from *within* an existing Prisma transaction (`tx` param required, never creates its own) — this forces every caller (capture, refund) to reason about atomicity explicitly rather than the ledger silently wrapping its own transaction and creating a window for the caller's other writes to be non-atomic with it.
  3. `createMany` the `LedgerEntry` rows, then updates the relevant `LedgerAccount`-owning `Merchant.balanceCents` cache.
- **`RefundsModule`**
  - `POST /payment-intents/:id/refunds` (body: `amountCents?`, `reason?`) →
    1. Redis lock `lock:refund:${intentId}` (same fast-fail pattern as capture).
    2. Serializable transaction: `SELECT ... FOR UPDATE` the intent, assert `status === 'SUCCEEDED'`, assert `amountCents <= (intent.amountCapturedCents - intent.amountRefundedCents)` (enforces the "can't refund more than captured" balance limit from the requirements).
    3. Call `LedgerService.postDoubleEntry` with a group: DEBIT `MERCHANT_AVAILABLE` (money leaves merchant), CREDIT `PLATFORM_CLEARING` (simulated return to the original card network).
    4. Insert `Refund` row + update `PaymentIntent.amountRefundedCents`; if full refund, intent stays `SUCCEEDED` but a domain flag `fullyRefunded` (derived, not stored) is computed as `amountRefundedCents === amountCapturedCents` for API responses.
    5. Emit `refund.created` event → webhook queue.
  - Full vs. partial is not a separate code path — it's simply whether the requested amount equals the remaining refundable balance; this eliminates an entire class of duplicated logic bugs.
- Statement export (ties to MinIO): `GET /merchants/me/statements?month=2026-06` → enqueues a BullMQ `generate-statement` job; worker queries `LedgerEntry` for the period, renders a PDF (via `@react-pdf/renderer` or `pdfkit`), uploads to MinIO under `statements/{merchantId}/{yyyy-mm}.pdf`, returns a pre-signed URL persisted on a `StatementExport` record polled by the client (`GET /statements/:id` → `{status, downloadUrl}`).

### 3. Idempotency & Resiliency Strategy
- Refund creation goes through the same `Idempotency-Key` contract as capture and intent-creation — critical here because refunds move real (simulated) money and a duplicate refund is a direct financial loss to the merchant.
- The ledger's `transactionGroupId` doubles as a **natural idempotency anchor for reconciliation**: even if application-level idempotency somehow failed, the nightly reconciliation job (above) would surface an unbalanced or duplicated group for manual/automated remediation — a second line of defense at the data layer, independent of the request-handling layer.

### 4. Testing & Verification Plan
- Unit: `LedgerService.postDoubleEntry` throws if `sum(debits) !== sum(credits)` — never silently allows an unbalanced group.
- E2E: capture $100 → refund $30 → assert `amountRefundedCents = 3000`, merchant balance decreased by exactly $30, exactly 2 new `LedgerEntry` rows.
- E2E: attempt to refund $80 after a $30 refund on a $100 capture (total would be $110) → `422 Unprocessable Entity` with `code: REFUND_EXCEEDS_CAPTURED_AMOUNT`.
- Concurrency: fire two concurrent partial-refund requests that individually fit within the remaining balance but *together* would exceed it (e.g., two $60 refunds on a $100 capture) — assert exactly one succeeds and the other fails with `422`, never both succeeding (validates the `FOR UPDATE` + Serializable combination against the classic "check-then-act" race).
- Reconciliation job unit test: seed an intentionally unbalanced `LedgerEntry` pair directly via raw SQL (bypassing the service, simulating a hypothetical bug/corruption), run the job, assert it detects and reports the imbalance.
- Statement export: assert generated PDF is retrievable from MinIO via the pre-signed URL and contains the expected ledger line items (parse PDF text in test via `pdf-parse`).

---

## Phase 5: Idempotency Layer (Redis-backed)

### 1. Architectural & Database Schema Design
- No Postgres table required for the hot path — Redis is authoritative for idempotency records, by design, since they are inherently ephemeral (24h–7d TTL) and must not add latency to the financial write path.
- Redis key schema: `idem:{merchantId}:{idempotencyKey}` → JSON value:
  ```json
  {
    "requestHash": "sha256 of method+path+body",
    "status": "IN_PROGRESS" | "COMPLETED",
    "responseStatusCode": 201,
    "responseBody": { "...": "..." },
    "lockedAt": "ISO timestamp"
  }
  ```
- TTL: `EX 86400` (24h) refreshed on completion — long enough to cover realistic client retry windows, short enough not to bloat Redis memory indefinitely.
- For durability beyond Redis's best-effort persistence, a lightweight `IdempotencyRecord` Postgres table (mirrors the Redis shape, written asynchronously) can be added as a fallback audit trail — **recommended for production hardening but explicitly deferred here** since Redis with AOF persistence enabled is sufficient for a simulator; noted as a documented trade-off, not an oversight.

### 2. Step-by-Step Implementation Steps
- **`IdempotencyInterceptor`** (NestJS `NestInterceptor`, registered via `@UseInterceptors(IdempotencyInterceptor)` on every state-changing controller method — capture, refund, create-intent, cancel):
  1. Reads `Idempotency-Key` header; if absent on an endpoint that requires it, throws `400 Bad Request` (enforced via a `@RequireIdempotencyKey()` custom decorator + metadata check inside the interceptor, so it's opt-in per-route rather than global boilerplate).
  2. Computes `requestHash = sha256(JSON.stringify(sortedBody))`.
  3. Attempts `SET idem:{merchantId}:{key} {...IN_PROGRESS...} NX EX 86400` (atomic — Redis `SET NX` is the concurrency primitive here, equivalent to the capture lock but for idempotency rather than resource contention).
     - **If the SET succeeds:** this is a genuinely new request. Proceed to `next.handle()`; on completion, overwrite the Redis record with `COMPLETED` + the serialized response, still with the original/refreshed TTL.
     - **If the SET fails (key exists):** fetch the existing record.
       - If `requestHash` differs from the stored hash → `422 Unprocessable Entity, code: IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` (prevents a client bug from silently reusing a key across unrelated requests).
       - If `status === 'IN_PROGRESS'` → `409 Conflict, code: REQUEST_IN_PROGRESS` (a concurrent identical request is already being handled — the client should retry after a short delay).
       - If `status === 'COMPLETED'` → replay the stored `responseStatusCode`/`responseBody` verbatim, **without re-executing any business logic**.
  4. Wrapped in `try/finally`: if the handler throws, the interceptor **deletes** the `IN_PROGRESS` record (rather than marking it completed with an error) so the client's retry with the same key is treated as fresh — failed requests should not permanently poison an idempotency key.
- Interceptor is registered at the **module level** (`APP_INTERCEPTOR` would apply globally and is deliberately avoided — idempotency is required only on mutating financial endpoints, applying it to `GET` routes would be both meaningless and a needless Redis round-trip on every read).

### 3. Idempotency & Resiliency Strategy
- This phase *is* the idempotency strategy — the above interceptor is the concrete mechanism referenced abstractly in Phases 2–4.
- Interaction with the Serializable-transaction retry logic in Phase 3: if a capture's DB transaction is retried internally due to a serialization failure, that retry happens **inside** a single interceptor invocation — the idempotency record only transitions to `COMPLETED` once the entire operation (including internal retries) finishes, so a client-visible retry never sees a partially-applied state.
- Redis connection failure fallback: if the idempotency Redis check itself fails (Redis down), the interceptor **fails closed** — rejects the request with `503 Service Unavailable` rather than silently skipping idempotency protection, since allowing an unprotected duplicate financial mutation is a worse failure mode than temporary unavailability.

### 4. Testing & Verification Plan
- E2E: two identical concurrent `POST` requests (same key, same body, fired via `Promise.all`) to `/payment-intents` → exactly one `201` executes business logic (assert single DB row), the other blocks until completion (or receives `409` if it arrives while the first is still `IN_PROGRESS`, then a subsequent retry with the same key returns the cached `201`).
- E2E: same `Idempotency-Key`, different request body → `422` with the specific error code, and confirm no duplicate business-logic execution occurred.
- E2E: handler throws mid-execution (simulate via a forced exception) → assert the Redis key is deleted, not left `IN_PROGRESS` forever, and a subsequent identical retry succeeds cleanly.
- Chaos test: `docker compose stop redis` mid-test → assert idempotency-protected endpoints return `503` rather than silently processing unprotected duplicates; assert non-idempotency-protected `GET` endpoints remain unaffected.
- Load test (k6 or autocannon): 100 concurrent identical capture requests with one idempotency key → assert Redis and Postgres show exactly one committed capture, response latency for the 99 "replayed" responses is near-zero (proves the cache short-circuit, not just correctness).

---

## Phase 6: Webhook Dispatch System (BullMQ)

### 1. Architectural & Database Schema Design
```prisma
model WebhookEndpoint {
  id           String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  merchantId   String   @db.Uuid
  merchant     Merchant @relation(fields: [merchantId], references: [id])
  url          String
  secret       String   // used to HMAC-sign payloads; shown once at creation like API keys
  enabledEvents String[] // ["payment_intent.succeeded", "refund.created", ...]
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())

  deliveries   WebhookDelivery[]
  @@index([merchantId])
}

model WebhookDelivery {
  id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  webhookEndpointId String   @db.Uuid
  webhookEndpoint   WebhookEndpoint @relation(fields: [webhookEndpointId], references: [id])
  eventType         String
  payload           Json
  status            WebhookDeliveryStatus @default(PENDING)
  attemptCount      Int      @default(0)
  lastAttemptAt     DateTime?
  lastResponseCode  Int?
  lastError         String?
  nextRetryAt       DateTime?
  createdAt         DateTime @default(now())

  @@index([webhookEndpointId, status])
  @@index([status, nextRetryAt])
}
enum WebhookDeliveryStatus { PENDING DELIVERED FAILED EXHAUSTED }
```
- `WebhookDelivery` is the **durable audit record**, decoupled from the BullMQ job itself (Redis/BullMQ job data is not guaranteed to persist indefinitely — the Postgres row is what merchants see in their dashboard's "webhook logs" tab and what powers manual "resend" actions).

### 2. Step-by-Step Implementation Steps
- **`WebhooksModule`**
  - `@OnEvent('payment_intent.succeeded')` (and siblings for `.failed`, `refund.created`, etc.) listener in `WebhookDispatcherService`:
    1. Looks up all `WebhookEndpoint` rows for the merchant where `isActive` and `eventType ∈ enabledEvents`.
    2. For each endpoint, creates a `WebhookDelivery` row (`status: PENDING`) and enqueues a BullMQ job on the `webhook-delivery` queue with `{ deliveryId }` as payload (not the full body — the processor re-reads from Postgres, keeping job payloads small and the DB as the single source of truth for retry state).
  - **Queue config:**
    ```ts
    new Queue('webhook-delivery', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 6,
        backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s, 40s, 80s, 160s
        removeOnComplete: { age: 3600 },
        removeOnFail: false, // keep failed jobs for inspection until EXHAUSTED is reached
      },
    });
    ```
  - **`WebhookDeliveryProcessor`** (`@Processor('webhook-delivery')`):
    1. Loads the `WebhookDelivery` + parent `WebhookEndpoint`.
    2. Computes `signature = HMAC-SHA256(endpoint.secret, `${timestamp}.${JSON.stringify(payload)}`)`, sends `POST` to `endpoint.url` with headers `X-Webhook-Signature: t=${timestamp},v1=${signature}` and `X-Webhook-Id: ${deliveryId}` (for merchant-side dedup), timeout 10s via `axios` with `AbortController`.
    3. On `2xx` → update delivery `status: DELIVERED`, `lastResponseCode`.
    4. On non-2xx or network error/timeout → increment `attemptCount`, set `lastError`, `lastResponseCode`; **throw** inside the processor so BullMQ's built-in `attempts`/`backoff` triggers the next retry automatically — no manual retry scheduling needed, BullMQ owns the backoff clock.
    5. `@OnQueueFailed` / a `Worker` `'failed'` event handler checks `job.attemptsMade >= job.opts.attempts`; if exhausted, sets delivery `status: EXHAUSTED` and optionally enqueues a low-priority alert (e.g., internal Slack-webhook-to-Anthropic-ops-style notification, or simply surfaces in the merchant dashboard's "attention needed" panel).
  - **Manual resend:** `POST /webhooks/deliveries/:id/resend` (dashboard action) resets `attemptCount = 0`, `status = PENDING`, re-enqueues a fresh job — reuses the exact same processor path, no special-cased logic.
  - **Signature verification helper** exposed as a documented utility (in Swagger + a small code snippet in API docs) so simulated "merchant" test servers can verify `X-Webhook-Signature` exactly as a real integration would: `hmac.update(`${timestamp}.${rawBody}`).digest('hex') === v1`, with a timestamp-tolerance window (5 min) to reject replayed old payloads.

### 3. Idempotency & Resiliency Strategy
- Webhook delivery is **at-least-once, not exactly-once** — this is called out explicitly rather than glossed over, matching real-world gateway behavior (Stripe, Adyen, etc. all document at-least-once delivery). The `X-Webhook-Id` header is provided specifically so merchant-side consumers can de-duplicate on their end; this contract is documented in the Swagger description for the webhook payload schema.
- The dispatcher itself is idempotent at the *creation* layer: `@OnEvent` handlers use the domain event's own unique identifier (e.g., the `PaymentIntentEvent.id`) as part of the BullMQ `jobId` (`webhook:${endpointId}:${paymentIntentEventId}`), so if the event emitter somehow fires twice for the same underlying transition (defensive coding against `EventEmitter2` quirks or a future move to a more distributed event bus), BullMQ deduplicates the enqueue.
- Network-drop mid-delivery is exactly the scenario the retry/backoff exists for — from the merchant's endpoint perspective this is indistinguishable from a slow response, which is why merchant endpoints are expected (and documented) to be idempotent themselves on `X-Webhook-Id`.

### 4. Testing & Verification Plan
- E2E with a local Supertest-driven mock HTTP server (`nock` or a throwaway `http.createServer`) acting as the "merchant's endpoint":
  - Happy path: trigger `payment_intent.succeeded`, assert the mock server receives a `POST` with correct signature within a few seconds; assert `WebhookDelivery.status === 'DELIVERED'`.
  - Signature test: assert an intentionally wrong secret fails signature verification on the receiving side (test the verification helper independently).
  - Retry/backoff test: configure the mock server to return `500` for the first 3 attempts then `200` on the 4th; assert `attemptCount` progression matches expected backoff timing (use Jest fake timers or BullMQ's test-mode to avoid real 5–160s waits in CI) and final `status: DELIVERED`.
  - Exhaustion test: mock server always returns `500`; assert after 6 attempts `status` becomes `EXHAUSTED` and no further jobs are scheduled.
  - **Network drop simulation:** mock server accepts the connection then destroys the socket mid-response (simulating a dropped connection rather than a clean error code) — assert the processor treats this as a retryable failure identically to a timeout.
  - Manual resend: force a delivery to `EXHAUSTED`, call the resend endpoint, assert a fresh delivery cycle occurs and can succeed.
  - Concurrency/dedup: emit the same domain event twice rapidly (simulating a defensive double-fire), assert only one `WebhookDelivery` row and one actual HTTP call occurs (BullMQ `jobId` dedup verified).

---

## Phase 7: Admin Dashboard & Failure Simulation

### 1. Architectural & Database Schema Design
```prisma
model AdminUser {
  id           String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email        String   @unique
  passwordHash String
  role         AdminRole @default(SUPPORT)
  createdAt    DateTime @default(now())
}
enum AdminRole { SUPPORT SUPERADMIN }

model GatewaySimulationConfig {
  id                String  @id @default("singleton") // enforced single-row config table
  globalFailureRate Float   @default(0) // 0.0–1.0, injected into the Phase 2 worker's outcome roll
  forcedOutcome     ForcedOutcome? // override for targeted testing (e.g., force next N intents to fail)
  latencyMsMin      Int     @default(200)
  latencyMsMax      Int     @default(1500)
  updatedAt         DateTime @updatedAt
  updatedByAdminId  String? @db.Uuid
}
enum ForcedOutcome { ALWAYS_SUCCEED ALWAYS_FAIL ALWAYS_REQUIRE_ACTION }
```
- Admin auth is **deliberately a separate `AdminUser` model and separate JWT audience** (`aud: 'admin'` claim) from `Merchant` — an admin token must never be usable against merchant-scoped endpoints and vice versa, enforced by a distinct `AdminJwtStrategy` + `AdminAccessGuard` checking the `aud` claim explicitly, not just presence of a valid signature.

### 2. Step-by-Step Implementation Steps
- **`AdminModule`** (entirely separate route prefix `/admin`, own Swagger tag, excluded from the public-facing API docs bundle via `@ApiExcludeController` toggle in non-admin doc builds if the docs are ever split into public/internal specs).
  - `GET /admin/merchants` — paginated list with search/filter (`email`, `status`, `createdAt` range), includes computed `balanceCents`, `totalVolumeCents` (aggregated via a raw `groupBy` query against `LedgerEntry`, not the cached balance, since admins need the ground-truth view).
  - `GET /admin/merchants/:id` — full detail including recent `PaymentIntentEvent` and `WebhookDelivery` history for support investigation.
  - `PATCH /admin/merchants/:id/status` — suspend/reactivate a merchant (`SUSPENDED` status is checked by a global `MerchantStatusGuard` applied to all merchant-facing financial endpoints, blocking new payment intents/captures/refunds from a suspended account while still allowing read access).
  - `GET /admin/transactions` — global ledger view, filterable by date range/currency/entryType, paginated, used for the "global transaction volumes" requirement — implemented as a raw SQL query with `SUM(...) OVER (PARTITION BY ...)` window functions for volume-by-day rollups, exposed as a dedicated `GET /admin/analytics/volume` endpoint returning pre-aggregated time-series data (so the dashboard frontend doesn't need to aggregate thousands of rows client-side).
  - `PATCH /admin/simulation-config` — updates the singleton `GatewaySimulationConfig` row (upsert on `id: 'singleton'`); the Phase 2 `PaymentProcessorProcessor` reads this config (cached in Redis with a short 5s TTL to avoid a DB hit on every single simulated payment) at the start of each job to decide the simulated outcome — this is how "manually override or simulate gateway failures" is satisfied concretely.
  - `POST /admin/payment-intents/:id/force-transition` (SUPERADMIN only, via `@Roles('SUPERADMIN')` + `RolesGuard`) — a manual escape hatch that runs through the *same* `PaymentIntentsService.transition()` method (never bypasses the state machine or optimistic locking) but is logged with an additional `PaymentIntentEvent.reason: 'ADMIN_OVERRIDE by ${adminId}'` for full auditability.

### 3. Idempotency & Resiliency Strategy
- Admin write endpoints (`status` changes, `force-transition`) are lower-frequency, human-operated actions — the same `Idempotency-Key` interceptor contract from Phase 5 is still applied (an admin's dashboard client can double-click too), but the risk profile is lower than the merchant-facing payment endpoints, so this is noted as applied-for-consistency rather than a novel mechanism.
- `GatewaySimulationConfig`'s Redis cache uses a short TTL specifically so that an admin turning off a "force failure" mode takes effect within 5 seconds platform-wide, without needing a cache-invalidation broadcast mechanism — an intentional simplicity/consistency trade-off documented here rather than over-engineered with pub/sub invalidation for a simulator's admin config.

### 4. Testing & Verification Plan
- E2E: admin login uses a completely separate credential set; assert an admin JWT rejected by merchant-facing guards (`403`) and a merchant JWT rejected by admin guards.
- E2E: suspend a merchant → assert subsequent `POST /payment-intents` from that merchant's API key returns `403, code: MERCHANT_SUSPENDED`; assert existing `GET` reads still function.
- E2E: set `forcedOutcome: ALWAYS_FAIL` via admin config → create a new payment intent → assert the worker transitions it to `FAILED` deterministically (proves the override wiring end-to-end, not just that the config row was written).
- RBAC test: a `SUPPORT`-role admin attempting `force-transition` receives `403`; a `SUPERADMIN` succeeds.
- Analytics test: seed known ledger entries across multiple days/currencies, assert `/admin/analytics/volume` returns correctly summed per-day/per-currency rollups matching a manually computed expected value.
- Audit test: after a `force-transition`, assert the resulting `PaymentIntentEvent.reason` string contains the acting admin's ID for traceability.

---

## Cross-Cutting: Testing & CI Strategy Summary

- **Test database strategy:** each Jest E2E test file runs against a real Postgres instance (via `docker-compose.test.yml` or Testcontainers) with `prisma migrate reset --force` between suites (not between individual tests, for speed) plus **transactional test isolation** where feasible — wrapping each test in a transaction that's rolled back, except for the concurrency tests which explicitly require multiple real connections and cannot use that pattern (documented exception).
- **Redis/BullMQ in tests:** use a real Redis instance (Testcontainers `redis:7-alpine`), but BullMQ queues are put into a synchronous/manual-processing test mode where possible, or tests explicitly `await queueEvents` completion rather than relying on `sleep()`, to keep CI both fast and non-flaky.
- **Coverage gates:** enforce ≥85% branch coverage specifically on `libs/ledger`, `libs/idempotency`, and the payment-intent state machine — the financial-integrity-critical paths — via `jest.config.ts` per-directory `coverageThreshold`, stricter than the repo-wide default.
- **CI pipeline order:** lint/typecheck → unit tests → `prisma migrate deploy` against ephemeral DB → E2E suite → concurrency/chaos suite (run separately, tagged `@concurrency`, allowed slightly longer timeout budgets) → build Docker images → (optional) contract test against the Swagger spec via `dredd` or `schemathesis` to catch drift between implementation and documentation.
