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
import { BOOKING_MAIL_JOB_KIND } from "@/modules/booking/services/mail";
import { QUOTE_JOB_KIND } from "@/modules/booking/services/quoting";

describe.skipIf(!runIntegrationTests)("booking decisions integration", () => {
  const customerIds: string[] = [];
  const userIds: string[] = [];
  const bookingIds: string[] = [];

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
          ? { advanceCents: 43_200, depositCents: 20_000, paymentDueAt: new Date() }
          : {}),
      },
    });
    bookingIds.push(created.id);
    return created;
  }

  afterEach(async () => {
    await db.integrationJob.deleteMany({
      where: {
        OR: bookingIds.flatMap((id) => [
          { idempotencyKey: `${QUOTE_JOB_KIND}:${id}` },
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
