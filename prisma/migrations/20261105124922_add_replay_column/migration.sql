-- Replay feature: mark rows created by replaying a previous call.
-- Hand-written (prisma migrate dev must not run against a DB with webhook
-- extension tables); applied with `prisma migrate deploy`.
-- Column naming follows the existing camelCase columns of webhook_calls.

-- AlterTable
ALTER TABLE "webhook_calls" ADD COLUMN "replayedFromId" BIGINT;

-- CreateIndex
CREATE INDEX "webhook_calls_replayedFromId_idx" ON "webhook_calls"("replayedFromId");
