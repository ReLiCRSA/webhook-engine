-- Engine-managed API bearer tokens (api_tokens): named, optionally expiring
-- bearer tokens that authenticate generic auth (useGlobalAuth webhooks and
-- /api/*) alongside the env master token (AUTH_BEARER_TOKEN).
-- Hand-written (prisma migrate dev must not run against a DB with webhook
-- extension tables); generated via `prisma migrate diff` against a shadow
-- database, applied with `prisma migrate deploy` / `npm run db:migrate`.
-- Column naming follows the existing camelCase columns of webhook_calls.

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "api_tokens_name_idx" ON "api_tokens"("name");
