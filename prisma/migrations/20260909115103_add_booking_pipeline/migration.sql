-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OPERATOR', 'ADMINISTRATOR');

-- CreateEnum
CREATE TYPE "BoardType" AS ENUM ('SELF_CATERING', 'FULL_BOARD');

-- CreateEnum
CREATE TYPE "BookingState" AS ENUM ('RECEIVED', 'IN_REVIEW', 'APPROVED', 'AWAITING_PAYMENT', 'CONFIRMED', 'INVOICED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HoldedDocumentType" AS ENUM ('ESTIMATE', 'RESERVE_INVOICE', 'FINAL_INVOICE');

-- CreateEnum
CREATE TYPE "IntegrationJobStatus" AS ENUM ('PENDING', 'CLAIMED', 'SUCCEEDED', 'DEAD');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('HOLDED', 'GRAVITY_FORMS', 'BOOKING_MAIL');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'OPERATOR';

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "taxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "addressLine" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "holdedContactId" TEXT,
    "negotiatedServiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "gravityEntryId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "state" "BookingState" NOT NULL DEFAULT 'RECEIVED',
    "boardType" "BoardType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "headcount" INTEGER NOT NULL,
    "billableUnits" INTEGER,
    "unitPriceCents" INTEGER,
    "advanceCents" INTEGER,
    "depositCents" INTEGER,
    "paymentDueAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HoldedDocument" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "type" "HoldedDocumentType" NOT NULL,
    "holdedId" TEXT NOT NULL,
    "documentNumber" TEXT,
    "totalCents" INTEGER,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HoldedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAuditEvent" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "fromState" "BookingState",
    "toState" "BookingState" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IntegrationJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSettings" (
    "provider" "IntegrationProvider" NOT NULL,
    "config" JSONB NOT NULL,
    "secretCiphertext" BYTEA,
    "secretIv" BYTEA,
    "secretAuthTag" BYTEA,
    "verifiedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSettings_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "IntakeCursor" (
    "source" TEXT NOT NULL,
    "lastEntryId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeCursor_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_taxId_key" ON "Customer"("taxId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_gravityEntryId_key" ON "BookingRequest"("gravityEntryId");

-- CreateIndex
CREATE INDEX "BookingRequest_state_createdAt_idx" ON "BookingRequest"("state", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_customerId_idx" ON "BookingRequest"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "HoldedDocument_bookingRequestId_type_key" ON "HoldedDocument"("bookingRequestId", "type");

-- CreateIndex
CREATE INDEX "Payment_bookingRequestId_idx" ON "Payment"("bookingRequestId");

-- CreateIndex
CREATE INDEX "BookingAuditEvent_bookingRequestId_createdAt_idx" ON "BookingAuditEvent"("bookingRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationJob_idempotencyKey_key" ON "IntegrationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "IntegrationJob_status_runAfter_idx" ON "IntegrationJob"("status", "runAfter");

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HoldedDocument" ADD CONSTRAINT "HoldedDocument_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAuditEvent" ADD CONSTRAINT "BookingAuditEvent_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAuditEvent" ADD CONSTRAINT "BookingAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSettings" ADD CONSTRAINT "IntegrationSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
