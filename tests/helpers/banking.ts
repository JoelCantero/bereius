import { randomBytes, randomUUID } from "node:crypto";

type DatabaseClient = typeof import("@/lib/db").db;
type FixtureUserRole = "OPERATOR" | "ADMINISTRATOR";
type FixtureRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "RETRYING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED";

function bankDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function createBankingFixtureScope(label = "banking") {
  const scopeId = `${label}-${randomUUID()}`;
  const accountIds = new Set<string>();
  const bookingIds = new Set<string>();
  const customerIds = new Set<string>();
  const userIds = new Set<string>();
  let sequence = 0;

  function nextId(kind: string) {
    sequence += 1;
    return `${scopeId}-${kind}-${sequence}`;
  }

  function providerId() {
    return randomBytes(12).toString("hex");
  }

  function user(overrides: {
    id?: string;
    email?: string;
    role?: FixtureUserRole;
  } = {}) {
    const id = overrides.id ?? nextId("user");
    const email = overrides.email ?? `${nextId("email")}@example.test`;
    userIds.add(id);
    return {
      id,
      email,
      normalizedEmail: email.toLowerCase(),
      name: "Synthetic Banking User",
      status: "ACTIVE" as const,
      role: overrides.role ?? "OPERATOR",
      emailVerified: new Date("2026-09-01T00:00:00.000Z"),
    };
  }

  function treasuryAccount(overrides: {
    id?: string;
    holdedAccountId?: string;
    displayName?: string;
    currency?: string;
    importStartDate?: Date;
    retentionFloorDate?: Date | null;
    active?: boolean;
    configuredById?: string | null;
    nextScheduledAt?: Date;
  } = {}) {
    const id = overrides.id ?? nextId("treasury-account");
    accountIds.add(id);
    return {
      id,
      holdedAccountId: overrides.holdedAccountId ?? providerId(),
      displayName: overrides.displayName ?? "Synthetic treasury account",
      currency: overrides.currency ?? "EUR",
      importStartDate: overrides.importStartDate ?? bankDate("2026-06-18"),
      retentionFloorDate: overrides.retentionFloorDate ?? null,
      active: overrides.active ?? true,
      configuredById: overrides.configuredById ?? null,
      nextScheduledAt:
        overrides.nextScheduledAt ?? new Date("2026-09-16T00:00:00.000Z"),
    };
  }

  function movement(
    account: ReturnType<typeof treasuryAccount>,
    overrides: {
      id?: string;
      holdedMovementId?: string;
      bookingDate?: Date;
      valueDate?: Date | null;
      narrative?: string | null;
      amountMinor?: bigint;
      currency?: string;
      providerStatus?: string | null;
      direction?: "INCOME" | "EXPENSE";
      firstSeenAt?: Date;
      lastSeenAt?: Date;
    } = {},
  ) {
    const amountMinor = overrides.amountMinor ?? BigInt(12_550);
    return {
      id: overrides.id ?? nextId("movement"),
      accountId: account.id,
      holdedMovementId: overrides.holdedMovementId ?? providerId(),
      bookingDate: overrides.bookingDate ?? bankDate("2026-09-16"),
      valueDate:
        overrides.valueDate === undefined
          ? bankDate("2026-09-16")
          : overrides.valueDate,
      narrative: overrides.narrative ?? "Synthetic movement narrative",
      amountMinor,
      currency: overrides.currency ?? "EUR",
      providerStatus: overrides.providerStatus ?? "pending",
      direction:
        overrides.direction ?? (amountMinor > BigInt(0) ? "INCOME" : "EXPENSE"),
      firstSeenAt:
        overrides.firstSeenAt ?? new Date("2026-09-16T10:00:00.000Z"),
      lastSeenAt:
        overrides.lastSeenAt ?? new Date("2026-09-16T10:00:00.000Z"),
    };
  }

  function run(
    account: ReturnType<typeof treasuryAccount>,
    overrides: {
      id?: string;
      trigger?: "SCHEDULED" | "MANUAL" | "EXPIRY";
      status?: FixtureRunStatus;
      windowStartDate?: Date;
      nextCursor?: string | null;
      exhaustedAt?: Date | null;
      finishedAt?: Date | null;
    } = {},
  ) {
    return {
      id: overrides.id ?? nextId("run"),
      accountId: account.id,
      trigger: overrides.trigger ?? "MANUAL",
      status: overrides.status ?? "QUEUED",
      windowStartDate: overrides.windowStartDate ?? account.importStartDate,
      nextCursor: overrides.nextCursor ?? null,
      nextAttemptAt: new Date("2026-09-16T10:00:00.000Z"),
      exhaustedAt: overrides.exhaustedAt ?? null,
      finishedAt: overrides.finishedAt ?? null,
    };
  }

  function customer(overrides: { id?: string; taxId?: string } = {}) {
    const id = overrides.id ?? nextId("customer");
    customerIds.add(id);
    return {
      id,
      taxId: overrides.taxId ?? nextId("tax-id"),
      name: "Synthetic Customer",
      email: `${nextId("customer")}@example.test`,
    };
  }

  function booking(
    owner: ReturnType<typeof customer>,
    overrides: {
      id?: string;
      gravityEntryId?: string;
      state?: "IN_REVIEW" | "AWAITING_PAYMENT" | "CONFIRMED" | "EXPIRED";
      advanceCents?: number | null;
      depositCents?: number | null;
      decidedAt?: Date | null;
    } = {},
  ) {
    const id = overrides.id ?? nextId("booking");
    bookingIds.add(id);
    return {
      id,
      gravityEntryId: overrides.gravityEntryId ?? nextId("gravity-entry"),
      customerId: owner.id,
      state: overrides.state ?? "AWAITING_PAYMENT",
      boardType: "SELF_CATERING" as const,
      startDate: bankDate("2026-10-01"),
      endDate: bankDate("2026-10-03"),
      headcount: 30,
      advanceCents: overrides.advanceCents ?? 10_000,
      depositCents: overrides.depositCents ?? 20_000,
      submittedAt: new Date("2026-09-15T12:00:00.000Z"),
      decidedAt: overrides.decidedAt ?? new Date("2026-09-15T12:00:00.000Z"),
    };
  }

  async function cleanup(database?: DatabaseClient) {
    const client = database ?? (await import("@/lib/db")).db;
    const trackedAccountIds = [...accountIds];
    const trackedBookingIds = [...bookingIds];
    const trackedCustomerIds = [...customerIds];
    const trackedUserIds = [...userIds];

    await client.$transaction(async (transaction) => {
      if (trackedAccountIds.length > 0) {
        await transaction.$executeRawUnsafe(
          'DELETE FROM "BankReconciliationProposal" WHERE "movementId" IN (SELECT "id" FROM "BankMovement" WHERE "accountId" = ANY($1::text[]))',
          trackedAccountIds,
        );
        await transaction.$executeRawUnsafe(
          'UPDATE "Payment" SET "bankMovementId" = NULL WHERE "bankMovementId" IN (SELECT "id" FROM "BankMovement" WHERE "accountId" = ANY($1::text[]))',
          trackedAccountIds,
        );
        await transaction.$executeRawUnsafe(
          'DELETE FROM "BankSyncRun" WHERE "accountId" = ANY($1::text[])',
          trackedAccountIds,
        );
        await transaction.$executeRawUnsafe(
          'DELETE FROM "BankMovement" WHERE "accountId" = ANY($1::text[])',
          trackedAccountIds,
        );
        await transaction.$executeRawUnsafe(
          'DELETE FROM "HoldedTreasuryAccount" WHERE "id" = ANY($1::text[])',
          trackedAccountIds,
        );
      }
      if (trackedBookingIds.length > 0) {
        await transaction.payment.deleteMany({
          where: { bookingRequestId: { in: trackedBookingIds } },
        });
        await transaction.holdedDocument.deleteMany({
          where: { bookingRequestId: { in: trackedBookingIds } },
        });
        await transaction.bookingAuditEvent.deleteMany({
          where: { bookingRequestId: { in: trackedBookingIds } },
        });
        await transaction.bookingRequest.deleteMany({
          where: { id: { in: trackedBookingIds } },
        });
      }
      if (trackedCustomerIds.length > 0) {
        await transaction.customer.deleteMany({
          where: { id: { in: trackedCustomerIds } },
        });
      }
      if (trackedUserIds.length > 0) {
        await transaction.user.deleteMany({ where: { id: { in: trackedUserIds } } });
      }
    });

    accountIds.clear();
    bookingIds.clear();
    customerIds.clear();
    userIds.clear();
  }

  return {
    scopeId,
    user,
    treasuryAccount,
    movement,
    run,
    customer,
    booking,
    cleanup,
  };
}