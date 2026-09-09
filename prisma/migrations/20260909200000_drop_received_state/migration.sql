-- A request is under review the moment it arrives, so RECEIVED no longer exists.
ALTER TABLE "BookingRequest" ALTER COLUMN "state" DROP DEFAULT;

UPDATE "BookingRequest" SET "state" = 'IN_REVIEW' WHERE "state" = 'RECEIVED';
UPDATE "BookingAuditEvent" SET "toState" = 'IN_REVIEW' WHERE "toState" = 'RECEIVED';
UPDATE "BookingAuditEvent" SET "fromState" = NULL WHERE "fromState" = 'RECEIVED';

-- Postgres cannot drop a value from an enum, so the type is rebuilt.
ALTER TYPE "BookingState" RENAME TO "BookingState_old";

CREATE TYPE "BookingState" AS ENUM ('IN_REVIEW', 'APPROVED', 'AWAITING_PAYMENT', 'CONFIRMED', 'INVOICED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED');

ALTER TABLE "BookingRequest"
  ALTER COLUMN "state" TYPE "BookingState" USING "state"::text::"BookingState";

ALTER TABLE "BookingAuditEvent"
  ALTER COLUMN "fromState" TYPE "BookingState" USING "fromState"::text::"BookingState",
  ALTER COLUMN "toState" TYPE "BookingState" USING "toState"::text::"BookingState";

DROP TYPE "BookingState_old";

ALTER TABLE "BookingRequest" ALTER COLUMN "state" SET DEFAULT 'IN_REVIEW';
