-- CreateEnum
CREATE TYPE "RepresentativeStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "EstimateDeliveryStatus" AS ENUM ('PREPARED', 'IN_FLIGHT', 'ACCEPTED', 'FAILED', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'WORDPRESS';

-- CreateTable
CREATE TABLE "CustomerRepresentative" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "principalHoldedContactId" TEXT NOT NULL,
    "principalWpUserId" TEXT NOT NULL,
    "delegateWpUserId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" "RepresentativeStatus" NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "phone" TEXT,
    "holdedPersonId" TEXT,
    "sourceOccurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerRepresentative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivedDelegateEvent" (
    "id" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "bodyDigest" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "principalWpUserId" TEXT NOT NULL,
    "delegateWpUserId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivedDelegateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateDelivery" (
    "id" TEXT NOT NULL,
    "holdedDocumentId" TEXT NOT NULL,
    "status" "EstimateDeliveryStatus" NOT NULL DEFAULT 'PREPARED',
    "toEmail" TEXT NOT NULL,
    "ccEmails" JSONB NOT NULL,
    "attemptedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "outcomeUnknownAt" TIMESTAMP(3),
    "lastFailureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EstimateDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerRepresentative_principalHoldedContactId_status_idx" ON "CustomerRepresentative"("principalHoldedContactId", "status");

-- CreateIndex
CREATE INDEX "CustomerRepresentative_customerId_status_idx" ON "CustomerRepresentative"("customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerRepresentative_delegateWpUserId_generation_key" ON "CustomerRepresentative"("delegateWpUserId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivedDelegateEvent_externalEventId_key" ON "ReceivedDelegateEvent"("externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "EstimateDelivery_holdedDocumentId_key" ON "EstimateDelivery"("holdedDocumentId");

-- CreateIndex
CREATE INDEX "EstimateDelivery_status_updatedAt_idx" ON "EstimateDelivery"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "CustomerRepresentative" ADD CONSTRAINT "CustomerRepresentative_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateDelivery" ADD CONSTRAINT "EstimateDelivery_holdedDocumentId_fkey" FOREIGN KEY ("holdedDocumentId") REFERENCES "HoldedDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
