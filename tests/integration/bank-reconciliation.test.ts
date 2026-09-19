// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";
import {
  listBookingPaymentCandidates,
  queryBankMovements,
} from "@/modules/banking/services/queries";
import {
  dismissReconciliationProposal,
  reconcileBankMovements,
} from "@/modules/banking/services/reconciliation";
import { createBankingFixtureScope } from "../helpers/banking";

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";
const scopes = new Set<ReturnType<typeof createBankingFixtureScope>>();

function scopeFor(label: string) {
  const scope = createBankingFixtureScope(label);
  scopes.add(scope);
  return scope;
}

async function matchingContext(label: string) {
  const scope = scopeFor(label);
  const customerData = scope.customer();
  await db.customer.create({ data: customerData });
  const bookingData = scope.booking(customerData, {
    state: "AWAITING_PAYMENT",
    advanceCents: 10_000,
    depositCents: 20_000,
  });
  const booking = await db.bookingRequest.create({ data: bookingData });
  await db.holdedDocument.create({
    data: {
      bookingRequestId: booking.id,
      type: "ESTIMATE",
      holdedId: `${scope.scopeId}-estimate`,
      documentNumber: "EST-1001",
      totalCents: 30_000,
      issuedAt: booking.decidedAt!,
    },
  });
  const accountData = scope.treasuryAccount({ active: false });
  await db.holdedTreasuryAccount.create({ data: accountData });
  return { scope, booking, accountData };
}

afterEach(async () => {
  await Promise.all(
    [...scopes].map(async (scope) => {
      await scope.cleanup();
      scopes.delete(scope);
    }),
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe.skipIf(!runIntegrationTests)("bank movement reconciliation", () => {
  it("finds an unreferenced income at the inclusive 5% limit after estimate creation", async () => {
    const { scope, booking, accountData } = await matchingContext(
      "bank-reconciliation-booking-candidates",
    );
    const eligible = await db.bankMovement.create({
      data: scope.movement(accountData, {
        bookingDate: new Date("2026-09-15T00:00:00.000Z"),
        narrative: "Synthetic transfer without estimate reference",
        amountMinor: BigInt(31_500),
      }),
    });
    await db.bankMovement.create({
      data: scope.movement(accountData, {
        bookingDate: new Date("2026-09-14T00:00:00.000Z"),
        narrative: "EST-1001 but before estimate creation",
        amountMinor: BigInt(30_000),
      }),
    });

    const candidates = await listBookingPaymentCandidates(booking.id);

    expect(candidates.map((candidate) => candidate.movementId)).toEqual([
      eligible.id,
    ]);
    expect(candidates[0]).toMatchObject({
      amountMinor: "31500",
      expectedAmountMinor: "30000",
      estimateReferenceFound: false,
    });
  });

  it("uses the estimate creation date instead of its later link date", async () => {
    const { scope, booking, accountData } = await matchingContext(
      "bank-reconciliation-linked-estimate-date",
    );
    await db.bookingRequest.update({
      where: { id: booking.id },
      data: { decidedAt: new Date("2026-09-18T13:00:00.000Z") },
    });
    await db.holdedDocument.update({
      where: {
        bookingRequestId_type: {
          bookingRequestId: booking.id,
          type: "ESTIMATE",
        },
      },
      data: { issuedAt: new Date("2026-09-13T00:00:00.000Z") },
    });
    const movement = await db.bankMovement.create({
      data: scope.movement(accountData, {
        bookingDate: new Date("2026-09-17T00:00:00.000Z"),
        narrative: "Synthetic transfer without estimate reference",
        amountMinor: BigInt(30_000),
      }),
    });

    const candidates = await listBookingPaymentCandidates(booking.id);

    expect(candidates.map((candidate) => candidate.movementId)).toContain(
      movement.id,
    );
  });

  it("proposes only a literal-reference exact-EUR income", async () => {
    const { scope, booking, accountData } = await matchingContext(
      "bank-reconciliation-rules",
    );
    const movements = [
      scope.movement(accountData, {
        narrative: "Synthetic transfer EST-1001 received",
        amountMinor: BigInt(30_000),
      }),
      scope.movement(accountData, {
        narrative: "Synthetic transfer EST-1001 received",
        amountMinor: BigInt(-30_000),
      }),
      scope.movement(accountData, {
        narrative: "Synthetic transfer without estimate",
        amountMinor: BigInt(30_000),
      }),
      scope.movement(accountData, {
        narrative: "Synthetic transfer est-1001 received",
        amountMinor: BigInt(30_000),
      }),
      scope.movement(accountData, {
        narrative: "Synthetic transfer EST-1001 received",
        amountMinor: BigInt(10_000),
      }),
      scope.movement(accountData, {
        narrative: "Synthetic transfer EST-1001 received",
        amountMinor: BigInt(30_001),
      }),
      scope.movement(accountData, {
        narrative: "Synthetic transfer EST-1001 first half",
        amountMinor: BigInt(15_000),
      }),
      scope.movement(accountData, {
        narrative: "Synthetic transfer EST-1001 second half",
        amountMinor: BigInt(15_000),
      }),
      scope.movement(accountData, {
        narrative: "Synthetic transfer EST-1001 received",
        amountMinor: BigInt(30_000),
        currency: "USD",
      }),
      scope.movement(accountData, {
        narrative: null,
        amountMinor: BigInt(30_000),
      }),
    ];
    await db.bankMovement.createMany({ data: movements });

    await reconcileBankMovements(movements.map(({ id }) => id));

    await expect(
      db.bankReconciliationProposal.findMany({
        where: { bookingRequestId: booking.id },
        select: { movementId: true, status: true },
      }),
    ).resolves.toEqual([{ movementId: movements[0]!.id, status: "PENDING" }]);
    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }),
    ).resolves.toMatchObject({ state: "AWAITING_PAYMENT" });
    await expect(
      db.payment.count({ where: { bookingRequestId: booking.id } }),
    ).resolves.toBe(0);
    await expect(
      db.bookingAuditEvent.count({ where: { bookingRequestId: booking.id } }),
    ).resolves.toBe(0);
  });

  it("does not normalize whitespace in an estimate reference", async () => {
    const { scope, booking, accountData } = await matchingContext(
      "bank-reconciliation-literal-whitespace",
    );
    await db.holdedDocument.update({
      where: {
        bookingRequestId_type: {
          bookingRequestId: booking.id,
          type: "ESTIMATE",
        },
      },
      data: { documentNumber: "  EST-1001  " },
    });
    const movement = await db.bankMovement.create({
      data: scope.movement(accountData, {
        narrative: "Synthetic transfer EST-1001 received",
        amountMinor: BigInt(30_000),
      }),
    });

    await reconcileBankMovements([movement.id]);

    await expect(
      db.bankReconciliationProposal.count({
        where: { movementId: movement.id, bookingRequestId: booking.id },
      }),
    ).resolves.toBe(0);
  });

  it("keeps proposals idempotent and a dismissal durable across rescans", async () => {
    const { scope, booking, accountData } = await matchingContext(
      "bank-reconciliation-dismissal",
    );
    const actorData = scope.user();
    const actor = await db.user.create({ data: actorData });
    const movementData = scope.movement(accountData, {
      narrative: "EST-1001 synthetic exact payment",
      amountMinor: BigInt(30_000),
    });
    const movement = await db.bankMovement.create({ data: movementData });

    await reconcileBankMovements([movement.id]);
    await reconcileBankMovements([movement.id]);
    const proposal = await db.bankReconciliationProposal.findFirstOrThrow({
      where: { movementId: movement.id, bookingRequestId: booking.id },
    });
    await expect(
      db.bankReconciliationProposal.count({ where: { movementId: movement.id } }),
    ).resolves.toBe(1);

    const decidedAt = new Date("2026-09-16T15:00:00.000Z");
    await dismissReconciliationProposal({
      proposalId: proposal.id,
      actorUserId: actor.id,
      now: decidedAt,
    });
    await reconcileBankMovements([movement.id]);

    await expect(
      db.bankReconciliationProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      }),
    ).resolves.toMatchObject({
      status: "DISMISSED",
      decidedById: actor.id,
      decidedAt,
    });
    await expect(
      db.payment.count({ where: { bookingRequestId: booking.id } }),
    ).resolves.toBe(0);
  });

  it("invalidates a pending proposal after an ineligible correction", async () => {
    const { scope, booking, accountData } = await matchingContext(
      "bank-reconciliation-correction",
    );
    const movementData = scope.movement(accountData, {
      narrative: "EST-1001 synthetic exact payment",
      amountMinor: BigInt(30_000),
    });
    const movement = await db.bankMovement.create({ data: movementData });
    await reconcileBankMovements([movement.id]);

    await db.bankMovement.update({
      where: { id: movement.id },
      data: { amountMinor: BigInt(29_999) },
    });
    await reconcileBankMovements([movement.id]);

    await expect(
      db.bankReconciliationProposal.findFirstOrThrow({
        where: { movementId: movement.id, bookingRequestId: booking.id },
      }),
    ).resolves.toMatchObject({
      status: "INVALIDATED",
      invalidationCode: "MOVEMENT_INELIGIBLE",
    });
    const proposal = await db.bankReconciliationProposal.findFirstOrThrow({
      where: { movementId: movement.id, bookingRequestId: booking.id },
    });
    expect(proposal.invalidatedAt).not.toBeNull();
  });

  it("preserves a confirmed decision and records a correction incident", async () => {
    const { scope, booking, accountData } = await matchingContext(
      "bank-reconciliation-confirmed-correction",
    );
    const actor = await db.user.create({ data: scope.user() });
    const movement = await db.bankMovement.create({
      data: scope.movement(accountData, {
        narrative: "EST-1001 synthetic exact payment",
        amountMinor: BigInt(30_000),
      }),
    });
    await reconcileBankMovements([movement.id]);
    const proposal = await db.bankReconciliationProposal.findFirstOrThrow({
      where: { movementId: movement.id, bookingRequestId: booking.id },
    });
    await db.$transaction([
      db.bankReconciliationProposal.update({
        where: { id: proposal.id },
        data: {
          status: "CONFIRMED",
          decidedById: actor.id,
          decidedAt: new Date("2026-09-16T15:00:00.000Z"),
        },
      }),
      db.payment.create({
        data: {
          bookingRequestId: booking.id,
          amountCents: 30_000,
          receivedAt: movement.bookingDate,
          reference: movement.narrative,
          recordedById: actor.id,
          bankMovementId: movement.id,
        },
      }),
      db.bookingRequest.update({
        where: { id: booking.id },
        data: { state: "CONFIRMED" },
      }),
    ]);
    const run = await db.bankSyncRun.create({
      data: scope.run(accountData, { status: "RUNNING" }),
    });
    await db.bankMovement.update({
      where: { id: movement.id },
      data: { amountMinor: BigInt(29_999) },
    });

    await expect(
      reconcileBankMovements([movement.id], undefined, {
        runId: run.id,
        pageNumber: 2,
      }),
    ).resolves.toMatchObject({ incidentCount: 1 });

    await expect(
      db.bankReconciliationProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      }),
    ).resolves.toMatchObject({ status: "CONFIRMED" });
    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }),
    ).resolves.toMatchObject({ state: "CONFIRMED" });
    await expect(
      db.payment.findUniqueOrThrow({ where: { bankMovementId: movement.id } }),
    ).resolves.toMatchObject({ amountCents: 30_000 });
    await expect(
      db.bankSyncIncident.findMany({ where: { runId: run.id } }),
    ).resolves.toMatchObject([
      {
        code: "CONFIRMED_MATCH_CHANGED",
        pageNumber: 2,
        itemIndex: null,
        holdedMovementId: movement.holdedMovementId,
      },
    ]);

    const projection = await queryBankMovements({
      direction: "all",
      from: undefined,
      to: undefined,
      account: accountData.holdedAccountId,
      currency: "EUR",
      q: "",
      page: 1,
    });
    expect(projection.rows).toEqual([
      expect.objectContaining({ id: movement.id, status: "reconciled" }),
    ]);
  });

  it("projects only authorized proposal context with a movement row", async () => {
    const { scope, booking, accountData } = await matchingContext(
      "bank-reconciliation-projection",
    );
    const actor = await db.user.create({ data: scope.user() });
    const movement = await db.bankMovement.create({
      data: scope.movement(accountData, {
        narrative: "EST-1001 synthetic exact payment",
        amountMinor: BigInt(30_000),
      }),
    });
    await reconcileBankMovements([movement.id]);
    const proposal = await db.bankReconciliationProposal.findFirstOrThrow({
      where: { movementId: movement.id, bookingRequestId: booking.id },
    });
    await dismissReconciliationProposal({
      proposalId: proposal.id,
      actorUserId: actor.id,
      now: new Date("2026-09-16T15:00:00.000Z"),
    });

    const projection = await queryBankMovements({
      direction: "all",
      from: undefined,
      to: undefined,
      account: accountData.holdedAccountId,
      currency: "EUR",
      q: "",
      page: 1,
    });

    expect(projection.rows[0]?.proposals).toEqual([
      {
        id: proposal.id,
        status: "dismissed",
        movementId: movement.id,
        bookingRequestId: booking.id,
        estimateNumber: "EST-1001",
        amountMinor: "30000",
        currency: "EUR",
        movementDate: "2026-09-16",
        narrative: "EST-1001 synthetic exact payment",
        createdAt: expect.any(String),
        decidedAt: "2026-09-16T15:00:00.000Z",
        decidedByDisplay: "Synthetic Banking User",
      },
    ]);
    expect(JSON.stringify(projection.rows[0]?.proposals)).not.toContain(
      "Synthetic Customer",
    );
  });
});