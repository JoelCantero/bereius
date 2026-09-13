-- Delegate lifecycle and Holded person synchronization now belong to WordPress.
-- Estimate delivery remains in Bereius and reads the linked Holded projection.
DROP TABLE IF EXISTS "ReceivedDelegateEvent";
DROP TABLE IF EXISTS "CustomerRepresentative";
DROP TYPE IF EXISTS "RepresentativeStatus";

DELETE FROM "IntegrationSettings" WHERE "provider" = 'WORDPRESS';

ALTER TYPE "IntegrationProvider" RENAME TO "IntegrationProvider_old";
CREATE TYPE "IntegrationProvider" AS ENUM ('HOLDED', 'GRAVITY_FORMS', 'BOOKING_MAIL');
ALTER TABLE "IntegrationSettings"
    ALTER COLUMN "provider" TYPE "IntegrationProvider"
    USING ("provider"::text::"IntegrationProvider");
DROP TYPE "IntegrationProvider_old";