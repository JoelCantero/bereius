// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import { db } from "@/lib/db";
import {
  approveBooking,
  cancelBooking,
  PaymentError,
  recordPayment,
  rejectBooking,
} from "@/modules/booking/services/decisions";
import {
  confirmBookingPaymentCandidate,
  confirmReconciliationProposal,
} from "@/modules/banking/services/reconciliation";
import { BOOKING_MAIL_JOB_KIND } from "@/modules/booking/services/mail";
import { QUOTE_JOB_KIND } from "@/modules/booking/services/quoting";
import {
  RESERVE_INVOICE_JOB_KIND,
  reserveInvoiceJobKey,
} from "@/modules/booking/services/reserve-invoice";
import { createBankingFixtureScope } from "../helpers/banking";

describe.skipIf(!runIntegrationTests)("booking decisions integration", () => {
  const customerIds: string[] = [];
  const userIds: string[] = [];
  const bookingIds: string[] = [];
  const bankingScopes = new Set<ReturnType<typeof createBankingFixtureScope>>();

  async function operator() {
    const email = `operator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const user = await db.user.create({
      data: { email, normalizedEmail: email, status: "ACTIVE" },
    });
    userIds.push(user.id);
    return user;
  }

  async function booking(state: "IN_REVIEW" | "AWAITING_PAYMENT" = "IN_REVIEW") {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customer = await db.customer.create({
      data: {
        taxId: `D${suffix}`.slice(0, 20),
        name: "Fixture group",
        email: `group-${suffix}@example.test`,
      },
    });
    customerIds.push(customer.id);

    const created = await db.bookingRequest.create({
      data: {
        gravityEntryId: `decision-${suffix}`,
        customerId: customer.id,
        state,
        boardType: "SELF_CATERING",
        startDate: new Date("2027-06-01T00:00:00.000Z"),
        endDate: new Date("2027-06-03T00:00:00.000Z"),
        headcount: 40,
        submittedAt: new Date(),
        ...(state === "AWAITING_PAYMENT"
          ? {
              advanceCents: 43_200,
              depositCents: 20_000,
              paymentDueAt: new Date(),
              decidedAt: new Date("2026-09-10T15:00:00.000Z"),
            }
          : {}),
      },
    });
    bookingIds.push(created.id);
    return created;
  }

  async function pendingProposal(request: Awaited<ReturnType<typeof booking>>) {
    const scope = createBankingFixtureScope("booking-decision-proposal");
    bankingScopes.add(scope);
    const accountData = scope.treasuryAccount({ active: false });
    await db.holdedTreasuryAccount.create({ data: accountData });
    const movementData = scope.movement(accountData, {
      bookingDate: new Date("2026-09-12T00:00:00.000Z"),
      narrative: "Synthetic transfer EST-63200 received",
      amountMinor: BigInt(63_200),
    });
    const movement = await db.bankMovement.create({ data: movementData });
    await db.holdedDocument.create({
      data: {
        bookingRequestId: request.id,
        type: "ESTIMATE",
        holdedId: `${scope.scopeId}-estimate`,
        documentNumber: "EST-63200",
        totalCents: 63_200,
        issuedAt: request.decidedAt!,
      },
    });
    const proposal = await db.bankReconciliationProposal.create({
      data: { movementId: movement.id, bookingRequestId: request.id },
    });
    return { movement, proposal };
  }

  afterEach(async () => {
    await Promise.all(
      [...bankingScopes].map(async (scope) => {
        await scope.cleanup();
        bankingScopes.delete(scope);
      }),
    );
    await db.integrationJob.deleteMany({
      where: {
        OR: bookingIds.flatMap((id) => [
          { idempotencyKey: `${QUOTE_JOB_KIND}:${id}` },
          { idempotencyKey: reserveInvoiceJobKey(id) },
          { idempotencyKey: { startsWith: `${BOOKING_MAIL_JOB_KIND}:` } },
        ]),
      },
    });
    await db.bookingRequest.deleteMany({ where: { customerId: { in: customerIds } } });
    await db.customer.deleteMany({ where: { id: { in: customerIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    customerIds.length = 0;
    userIds.length = 0;
    bookingIds.length = 0;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("approving queues the Holded work and moves the booking to awaiting payment", async () => {
    const actor = await operator();
    const request = await booking("IN_REVIEW");

    await approveBooking({ bookingRequestId: request.id, actorUserId: actor.id });

    const updated = await db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(updated.state).toBe("AWAITING_PAYMENT");
    expect(updated.paymentDueAt).not.toBeNull();

    await expect(
      db.integrationJob.count({ where: { idempotencyKey: `${QUOTE_JOB_KIND}:${request.id}` } }),
    ).resolves.toBe(1);
  });

  it("queues the quote exactly once even if approval is attempted twice", async () => {
    const actor = await operator();
    const request = await booking("IN_REVIEW");

    await approveBooking({ bookingRequestId: request.id, actorUserId: actor.id });
    await expect(
      approveBooking({ bookingRequestId: request.id, actorUserId: actor.id }),
    ).rejects.toThrow();

    await expect(
      db.integrationJob.count({ where: { idempotencyKey: `${QUOTE_JOB_KIND}:${request.id}` } }),
    ).resolves.toBe(1);
  });

  it("rejecting requires a reason and notifies the requester", async () => {
    const actor = await operator();
    const request = await booking();

    await expect(
      rejectBooking({ bookingRequestId: request.id, actorUserId: actor.id }),
    ).rejects.toMatchObject({ code: "reason_required" });

    await rejectBooking({
      bookingRequestId: request.id,
      actorUserId: actor.id,
      reason: "dates unavailable",
    });

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "REJECTED" });
    await expect(
      db.integrationJob.count({
        where: { idempotencyKey: `${BOOKING_MAIL_JOB_KIND}:rejected:${request.id}` },
      }),
    ).resolves.toBe(1);
  });

  it("refuses a decision taken from a stale screen", async () => {
    const actor = await operator();
    const request = await booking();
    await approveBooking({
      bookingRequestId: request.id,
      actorUserId: actor.id,
      expectedFrom: "IN_REVIEW",
    });

    await expect(
      approveBooking({
        bookingRequestId: request.id,
        actorUserId: actor.id,
        expectedFrom: "IN_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "state_changed" });
  });

  it("confirms a booking when the transfer matches to the cent", async () => {
    const actor = await operator();
    const request = await booking("AWAITING_PAYMENT");

    await recordPayment({
      bookingRequestId: request.id,
      actorUserId: actor.id,
      amountCents: 63_200,
      receivedAt: new Date(),
      reference: "PRE-1",
    });

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "CONFIRMED" });
    await expect(
      db.payment.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(1);
  });

  it("rolls back a manual payment when the booking state is stale", async () => {
    const actor = await operator();
    const request = await booking("AWAITING_PAYMENT");
    await db.bookingRequest.update({
      where: { id: request.id },
      data: { state: "CONFIRMED" },
    });

    await expect(
      recordPayment({
        bookingRequestId: request.id,
        actorUserId: actor.id,
        amountCents: 63_200,
        receivedAt: new Date("2026-09-12T00:00:00.000Z"),
      }),
    ).rejects.toThrow();

    await expect(
      db.payment.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
    await expect(
      db.bookingAuditEvent.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
    await expect(
      db.integrationJob.count({
        where: {
          idempotencyKey: `${BOOKING_MAIL_JOB_KIND}:confirmed:${request.id}`,
        },
      }),
    ).resolves.toBe(0);
  });

  it("records one manual payment, transition, audit event, and post-commit mail", async () => {
    const actor = await operator();
    const request = await booking("AWAITING_PAYMENT");
    const receivedAt = new Date("2026-09-12T00:00:00.000Z");

    await recordPayment({
      bookingRequestId: request.id,
      actorUserId: actor.id,
      amountCents: 63_200,
      receivedAt,
      reference: "Synthetic manual reference",
    });

    await expect(
      db.payment.findMany({ where: { bookingRequestId: request.id } }),
    ).resolves.toMatchObject([
      {
        amountCents: 63_200,
        receivedAt,
        reference: "Synthetic manual reference",
        recordedById: actor.id,
        bankMovementId: null,
      },
    ]);
    await expect(
      db.bookingAuditEvent.findMany({
        where: { bookingRequestId: request.id },
      }),
    ).resolves.toMatchObject([
      {
        actorUserId: actor.id,
        fromState: "AWAITING_PAYMENT",
        toState: "CONFIRMED",
      },
    ]);
    await expect(
      db.integrationJob.count({
        where: {
          idempotencyKey: `${BOOKING_MAIL_JOB_KIND}:confirmed:${request.id}`,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      db.documentIssuance.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
    await expect(
      db.integrationJob.count({
        where: { idempotencyKey: reserveInvoiceJobKey(request.id) },
      }),
    ).resolves.toBe(0);
  });

  it("rolls back a movement-backed decision when the booking state is stale", async () => {
    const actor = await operator();
    const request = await booking("AWAITING_PAYMENT");
    const { movement, proposal } = await pendingProposal(request);
    await db.bookingRequest.update({
      where: { id: request.id },
      data: { state: "CONFIRMED" },
    });

    await expect(
      confirmReconciliationProposal({
        proposalId: proposal.id,
        actorUserId: actor.id,
      }),
    ).rejects.toThrow();

    await expect(
      db.payment.count({ where: { bankMovementId: movement.id } }),
    ).resolves.toBe(0);
    await expect(
      db.bankReconciliationProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      }),
    ).resolves.toMatchObject({ status: "PENDING", decidedAt: null });
    await expect(
      db.bookingAuditEvent.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
  });

  it("maps one movement into one payment, decision, transition, and mail", async () => {
    const actor = await operator();
    const request = await booking("AWAITING_PAYMENT");
    const { movement, proposal } = await pendingProposal(request);
    const decidedAt = new Date("2026-09-16T15:00:00.000Z");

    await expect(
      confirmReconciliationProposal({
        proposalId: proposal.id,
        actorUserId: actor.id,
        now: decidedAt,
      }),
    ).resolves.toEqual({ bookingRequestId: request.id });

    await expect(
      db.payment.findMany({ where: { bankMovementId: movement.id } }),
    ).resolves.toMatchObject([
      {
        bookingRequestId: request.id,
        amountCents: 63_200,
        receivedAt: new Date("2026-09-12T00:00:00.000Z"),
        reference: movement.narrative,
        recordedById: actor.id,
      },
    ]);
    await expect(
      db.bankReconciliationProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      }),
    ).resolves.toMatchObject({
      status: "CONFIRMED",
      decidedById: actor.id,
      decidedAt,
    });
    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "CONFIRMED" });
    await expect(
      db.bookingAuditEvent.findMany({
        where: { bookingRequestId: request.id },
      }),
    ).resolves.toMatchObject([
      {
        actorUserId: actor.id,
        fromState: "AWAITING_PAYMENT",
        toState: "CONFIRMED",
      },
    ]);
    await expect(
      db.integrationJob.count({
        where: {
          idempotencyKey: `${BOOKING_MAIL_JOB_KIND}:confirmed:${request.id}`,
        },
      }),
    ).resolves.toBe(1);
    const payment = await db.payment.findUniqueOrThrow({
      where: { bankMovementId: movement.id },
    });
    await expect(
      db.documentIssuance.findUniqueOrThrow({
        where: {
          bookingRequestId_type: {
            bookingRequestId: request.id,
            type: "RESERVE_INVOICE",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "PREPARED",
      holdedDocumentId: null,
    });
    await expect(
      db.integrationJob.findUniqueOrThrow({
        where: { idempotencyKey: reserveInvoiceJobKey(request.id) },
      }),
    ).resolves.toMatchObject({
      kind: RESERVE_INVOICE_JOB_KIND,
      payload: { bookingRequestId: request.id, paymentId: payment.id },
    });

    await expect(
      confirmReconciliationProposal({
        proposalId: proposal.id,
        actorUserId: actor.id,
      }),
    ).rejects.toMatchObject({ code: "proposal_changed" });
    await expect(
      db.payment.count({ where: { bankMovementId: movement.id } }),
    ).resolves.toBe(1);
    await expect(
      db.bookingAuditEvent.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(1);
  });

  it("confirms an explicitly selected bank income within 5% and stores its real amount", async () => {
    const actor = await operator();
    const request = await booking("AWAITING_PAYMENT");
    const scope = createBankingFixtureScope("booking-decision-candidate");
    bankingScopes.add(scope);
    const accountData = scope.treasuryAccount({ active: false });
    await db.holdedTreasuryAccount.create({ data: accountData });
    const movement = await db.bankMovement.create({
      data: scope.movement(accountData, {
        bookingDate: new Date("2026-09-11T00:00:00.000Z"),
        narrative: "Synthetic payment without an estimate reference",
        amountMinor: BigInt(66_000),
      }),
    });

    await expect(
      confirmBookingPaymentCandidate({
        bookingRequestId: request.id,
        movementId: movement.id,
        actorUserId: actor.id,
        now: new Date("2026-09-16T15:00:00.000Z"),
      }),
    ).resolves.toEqual({ bookingRequestId: request.id });

    await expect(
      db.payment.findUniqueOrThrow({ where: { bankMovementId: movement.id } }),
    ).resolves.toMatchObject({
      bookingRequestId: request.id,
      amountCents: 66_000,
      receivedAt: new Date("2026-09-11T00:00:00.000Z"),
      reference: movement.narrative,
      recordedById: actor.id,
    });
    await expect(
      db.bankReconciliationProposal.findUniqueOrThrow({
        where: {
          movementId_bookingRequestId: {
            movementId: movement.id,
            bookingRequestId: request.id,
          },
        },
      }),
    ).resolves.toMatchObject({ status: "CONFIRMED", decidedById: actor.id });
    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "CONFIRMED" });
    const payment = await db.payment.findUniqueOrThrow({
      where: { bankMovementId: movement.id },
    });
    await expect(
      db.integrationJob.findUniqueOrThrow({
        where: { idempotencyKey: reserveInvoiceJobKey(request.id) },
      }),
    ).resolves.toMatchObject({
      kind: RESERVE_INVOICE_JOB_KIND,
      payload: { bookingRequestId: request.id, paymentId: payment.id },
    });
  });

  it.each([63_199, 63_201, 20_000])(
    "refuses a transfer of %i cents and leaves the booking awaiting payment",
    async (amountCents) => {
      const actor = await operator();
      const request = await booking("AWAITING_PAYMENT");

      await expect(
        recordPayment({
          bookingRequestId: request.id,
          actorUserId: actor.id,
          amountCents,
          receivedAt: new Date(),
        }),
      ).rejects.toBeInstanceOf(PaymentError);

      await expect(
        db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).resolves.toMatchObject({ state: "AWAITING_PAYMENT" });
      await expect(
        db.payment.count({ where: { bookingRequestId: request.id } }),
      ).resolves.toBe(0);
    },
  );

  it("cancels a confirmed booking with a recorded reason", async () => {
    const actor = await operator();
    const request = await booking("AWAITING_PAYMENT");
    await recordPayment({
      bookingRequestId: request.id,
      actorUserId: actor.id,
      amountCents: 63_200,
      receivedAt: new Date(),
    });

    await cancelBooking({
      bookingRequestId: request.id,
      actorUserId: actor.id,
      reason: "group called off the trip",
    });

    const events = await db.bookingAuditEvent.findMany({
      where: { bookingRequestId: request.id, toState: "CANCELLED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("group called off the trip");
  });
});
