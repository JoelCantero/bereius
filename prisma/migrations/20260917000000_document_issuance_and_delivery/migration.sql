-- RenameTable
ALTER TABLE "EstimateDelivery" RENAME TO "DocumentDelivery";

-- RenameEnum
ALTER TYPE "EstimateDeliveryStatus" RENAME TO "DocumentDeliveryStatus";

-- Keep database object names aligned with the renamed model.
ALTER TABLE "DocumentDelivery" RENAME CONSTRAINT "EstimateDelivery_pkey" TO "DocumentDelivery_pkey";
ALTER TABLE "DocumentDelivery" RENAME CONSTRAINT "EstimateDelivery_holdedDocumentId_fkey" TO "DocumentDelivery_holdedDocumentId_fkey";
ALTER INDEX "EstimateDelivery_holdedDocumentId_key" RENAME TO "DocumentDelivery_holdedDocumentId_key";
ALTER INDEX "EstimateDelivery_status_updatedAt_idx" RENAME TO "DocumentDelivery_status_updatedAt_idx";

-- CreateEnum
CREATE TYPE "DocumentIssuanceStatus" AS ENUM ('PREPARED', 'IN_FLIGHT', 'ISSUED', 'FAILED', 'BLOCKED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "DocumentIssuance" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "type" "HoldedDocumentType" NOT NULL,
    "holdedDocumentId" TEXT,
    "status" "DocumentIssuanceStatus" NOT NULL DEFAULT 'PREPARED',
    "attemptedAt" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "outcomeUnknownAt" TIMESTAMP(3),
    "lastFailureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentIssuance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIssuance_holdedDocumentId_key" ON "DocumentIssuance"("holdedDocumentId");
CREATE UNIQUE INDEX "DocumentIssuance_bookingRequestId_type_key" ON "DocumentIssuance"("bookingRequestId", "type");
CREATE INDEX "DocumentIssuance_status_updatedAt_idx" ON "DocumentIssuance"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "DocumentIssuance" ADD CONSTRAINT "DocumentIssuance_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentIssuance" ADD CONSTRAINT "DocumentIssuance_holdedDocumentId_fkey" FOREIGN KEY ("holdedDocumentId") REFERENCES "HoldedDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;