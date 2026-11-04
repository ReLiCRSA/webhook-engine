-- CreateTable
CREATE TABLE "webhook_calls" (
    "id" BIGSERIAL NOT NULL,
    "webhook" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "query" JSONB,
    "headers" JSONB,
    "body" JSONB,
    "status" INTEGER NOT NULL,
    "auth" TEXT NOT NULL DEFAULT 'none',
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_calls_webhook_createdAt_idx" ON "webhook_calls"("webhook", "createdAt");
