-- Approving a request is the act of asking for the deposit, not a state a
-- request rests in: APPROVED was always left within the same call.
ALTER TABLE "BookingRequest" ALTER COLUMN "state" DROP DEFAULT;

UPDATE "BookingRequest" SET "state" = 'AWAITING_PAYMENT' WHERE "state" = 'APPROVED';

-- The pair of rows that recorded the two-step move becomes one: the second was
-- only ever bookkeeping for a state nobody observed.
DELETE FROM "BookingAuditEvent" WHERE "fromState" = 'APPROVED' AND "toState" = 'AWAITING_PAYMENT';
UPDATE "BookingAuditEvent" SET "toState" = 'AWAITING_PAYMENT' WHERE "toState" = 'APPROVED';
UPDATE "BookingAuditEvent" SET "fromState" = 'AWAITING_PAYMENT' WHERE "fromState" = 'APPROVED';

-- Postgres cannot drop a value from an enum, so the type is rebuilt.
ALTER TYPE "BookingState" RENAME TO "BookingState_old";

CREATE TYPE "BookingState" AS ENUM ('IN_REVIEW', 'AWAITING_PAYMENT', 'CONFIRMED', 'INVOICED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED');

ALTER TABLE "BookingRequest"
  ALTER COLUMN "state" TYPE "BookingState" USING "state"::text::"BookingState";

ALTER TABLE "BookingAuditEvent"
  ALTER COLUMN "fromState" TYPE "BookingState" USING "fromState"::text::"BookingState",
  ALTER COLUMN "toState" TYPE "BookingState" USING "toState"::text::"BookingState";

DROP TYPE "BookingState_old";

ALTER TABLE "BookingRequest" ALTER COLUMN "state" SET DEFAULT 'IN_REVIEW';
