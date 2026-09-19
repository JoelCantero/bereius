-- CreateEnum
CREATE TYPE "BankMovementDirection" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "BankSyncTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'EXPIRY');

-- CreateEnum
CREATE TYPE "BankSyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "BankSyncIncidentCode" AS ENUM (
    'PROVIDER_UNAUTHORIZED',
    'PROVIDER_NOT_FOUND',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_REQUEST_REJECTED',
    'RESPONSE_TOO_LARGE',
    'MALFORMED_PAGE',
    'MISSING_CURSOR',
    'REPEATED_CURSOR',
    'INVALID_MOVEMENT_ID',
    'ACCOUNT_MISMATCH',
    'INVALID_BOOKING_DATE',
    'INVALID_VALUE_DATE',
    'INVALID_AMOUNT',
    'ZERO_AMOUNT',
    'INVALID_CURRENCY',
    'DESCRIPTION_TOO_LONG',
    'CONFIRMED_MATCH_CHANGED'
);

-- CreateEnum
CREATE TYPE "BankReconciliationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED', 'INVALIDATED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "bankMovementId" TEXT;

-- CreateTable
CREATE TABLE "HoldedTreasuryAccount" (
    "id" TEXT NOT NULL,
    "holdedAccountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "importStartDate" DATE NOT NULL,
    "retentionFloorDate" DATE,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "configuredById" TEXT,
    "nextScheduledAt" TIMESTAMP(3) NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessfulAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HoldedTreasuryAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HoldedTreasuryAccount_id_check" CHECK ("holdedAccountId" ~ '^[0-9A-Fa-f]{24}$'),
    CONSTRAINT "HoldedTreasuryAccount_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);

-- CreateTable
CREATE TABLE "BankMovement" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "holdedMovementId" TEXT NOT NULL,
    "bookingDate" DATE NOT NULL,
    "valueDate" DATE,
    "narrative" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "providerStatus" TEXT,
    "direction" "BankMovementDirection" NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankMovement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BankMovement_id_check" CHECK ("holdedMovementId" ~ '^[0-9A-Fa-f]{24}$'),
    CONSTRAINT "BankMovement_amount_nonzero_check" CHECK ("amountMinor" <> 0),
    CONSTRAINT "BankMovement_direction_sign_check" CHECK (
        ("direction" = 'INCOME' AND "amountMinor" > 0)
        OR ("direction" = 'EXPENSE' AND "amountMinor" < 0)
    ),
    CONSTRAINT "BankMovement_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);

-- CreateTable
CREATE TABLE "BankSyncRun" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "trigger" "BankSyncTrigger" NOT NULL,
    "status" "BankSyncStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedById" TEXT,
    "resumedFromRunId" TEXT,
    "windowStartDate" DATE NOT NULL,
    "nextCursor" TEXT,
    "lastProcessedMovementId" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "incidentCount" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "failureCode" "BankSyncIncidentCode",
    "startedAt" TIMESTAMP(3),
    "exhaustedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankSyncRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BankSyncRun_counters_nonnegative_check" CHECK (
        "pageCount" >= 0
        AND "itemCount" >= 0
        AND "insertedCount" >= 0
        AND "updatedCount" >= 0
        AND "unchangedCount" >= 0
        AND "incidentCount" >= 0
        AND "attemptCount" >= 0
    )
);

-- CreateTable
CREATE TABLE "BankSyncIncident" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "code" "BankSyncIncidentCode" NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "itemIndex" INTEGER,
    "holdedMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankSyncIncident_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BankSyncIncident_page_number_check" CHECK ("pageNumber" >= 1),
    CONSTRAINT "BankSyncIncident_item_index_check" CHECK ("itemIndex" IS NULL OR "itemIndex" >= 0),
    CONSTRAINT "BankSyncIncident_movement_id_check" CHECK ("holdedMovementId" IS NULL OR "holdedMovementId" ~ '^[0-9A-Fa-f]{24}$')
);

-- CreateTable
CREATE TABLE "BankReconciliationProposal" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "status" "BankReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "invalidationCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankReconciliationProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HoldedTreasuryAccount_holdedAccountId_key" ON "HoldedTreasuryAccount"("holdedAccountId");
CREATE UNIQUE INDEX "HoldedTreasuryAccount_one_active_idx" ON "HoldedTreasuryAccount"("active") WHERE "active" = true;
CREATE INDEX "HoldedTreasuryAccount_active_nextScheduledAt_idx" ON "HoldedTreasuryAccount"("active", "nextScheduledAt");
CREATE UNIQUE INDEX "BankMovement_accountId_holdedMovementId_key" ON "BankMovement"("accountId", "holdedMovementId");
CREATE INDEX "BankMovement_bookingDate_holdedMovementId_idx" ON "BankMovement"("bookingDate" DESC, "holdedMovementId");
CREATE INDEX "BankMovement_accountId_bookingDate_idx" ON "BankMovement"("accountId", "bookingDate" DESC);
CREATE INDEX "BankMovement_direction_bookingDate_idx" ON "BankMovement"("direction", "bookingDate" DESC);
CREATE INDEX "BankMovement_currency_bookingDate_idx" ON "BankMovement"("currency", "bookingDate" DESC);
CREATE UNIQUE INDEX "BankSyncRun_one_nonterminal_per_account_idx" ON "BankSyncRun"("accountId") WHERE "status" IN ('QUEUED', 'RUNNING', 'RETRYING');
CREATE INDEX "BankSyncRun_status_nextAttemptAt_idx" ON "BankSyncRun"("status", "nextAttemptAt");
CREATE INDEX "BankSyncRun_accountId_createdAt_idx" ON "BankSyncRun"("accountId", "createdAt" DESC);
CREATE INDEX "BankSyncIncident_runId_createdAt_idx" ON "BankSyncIncident"("runId", "createdAt");
CREATE UNIQUE INDEX "BankReconciliationProposal_movementId_bookingRequestId_key" ON "BankReconciliationProposal"("movementId", "bookingRequestId");
CREATE INDEX "BankReconciliationProposal_status_createdAt_idx" ON "BankReconciliationProposal"("status", "createdAt" DESC);
CREATE INDEX "BankReconciliationProposal_bookingRequestId_status_idx" ON "BankReconciliationProposal"("bookingRequestId", "status");
CREATE UNIQUE INDEX "Payment_bankMovementId_key" ON "Payment"("bankMovementId");

-- AddForeignKey
ALTER TABLE "HoldedTreasuryAccount" ADD CONSTRAINT "HoldedTreasuryAccount_configuredById_fkey" FOREIGN KEY ("configuredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BankMovement" ADD CONSTRAINT "BankMovement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HoldedTreasuryAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankSyncRun" ADD CONSTRAINT "BankSyncRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HoldedTreasuryAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankSyncRun" ADD CONSTRAINT "BankSyncRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BankSyncRun" ADD CONSTRAINT "BankSyncRun_resumedFromRunId_fkey" FOREIGN KEY ("resumedFromRunId") REFERENCES "BankSyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BankSyncIncident" ADD CONSTRAINT "BankSyncIncident_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BankSyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankReconciliationProposal" ADD CONSTRAINT "BankReconciliationProposal_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "BankMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankReconciliationProposal" ADD CONSTRAINT "BankReconciliationProposal_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankReconciliationProposal" ADD CONSTRAINT "BankReconciliationProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bankMovementId_fkey" FOREIGN KEY ("bankMovementId") REFERENCES "BankMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;