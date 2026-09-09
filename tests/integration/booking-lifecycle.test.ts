// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import type { BookingState } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import {
  BookingTransitionError,
  canTransition,
  isTerminal,
  requiresReason,
  transitionBooking,
} from "@/modules/booking/services/lifecycle";

const ALL_STATES: readonly BookingState[] = [
  "IN_REVIEW",
  "APPROVED",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "INVOICED",
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
];

const LEGAL_TRANSITIONS: ReadonlyArray<[BookingState, BookingState]> = [
  ["IN_REVIEW", "APPROVED"],
  ["IN_REVIEW", "REJECTED"],
  ["APPROVED", "AWAITING_PAYMENT"],
  ["APPROVED", "CANCELLED"],
  ["AWAITING_PAYMENT", "CONFIRMED"],
  ["AWAITING_PAYMENT", "EXPIRED"],
  ["AWAITING_PAYMENT", "CANCELLED"],
  ["CONFIRMED", "INVOICED"],
  ["CONFIRMED", "CANCELLED"],
  ["INVOICED", "COMPLETED"],
];

describe.skipIf(!runIntegrationTests)("booking lifecycle integration", () => {
  const createdCustomerIds: string[] = [];

  async function createBooking(state: BookingState) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const customer = await db.customer.create({
      data: {
        taxId: `X${suffix}`.slice(0, 20),
        name: "Fixture group",
        email: `fixture-${suffix}@example.test`,
      },
    });
    createdCustomerIds.push(customer.id);

    return db.bookingRequest.create({
      data: {
        gravityEntryId: `entry-${suffix}`,
        customerId: customer.id,
        state,
        boardType: "SELF_CATERING",
        startDate: new Date("2027-06-01T00:00:00.000Z"),
        endDate: new Date("2027-06-03T00:00:00.000Z"),
        headcount: 40,
        submittedAt: new Date(),
      },
    });
  }

  afterEach(async () => {
    if (createdCustomerIds.length === 0) return;
    // Customer deletion is restricted while bookings reference it, so fixtures
    // unwind in the same order production would have to.
    await db.bookingRequest.deleteMany({
      where: { customerId: { in: createdCustomerIds } },
    });
    await db.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
    createdCustomerIds.length = 0;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it.each(LEGAL_TRANSITIONS)("moves a booking from %s to %s", async (from, to) => {
    const booking = await createBooking(from);

    await expect(
      transitionBooking({
        bookingRequestId: booking.id,
        to,
        actorUserId: null,
        reason: requiresReason(to) ? "documented reason" : undefined,
      }),
    ).resolves.toEqual({ bookingRequestId: booking.id, from, to });

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }),
    ).resolves.toMatchObject({ state: to });
  });

  it("refuses every transition that is not declared legal", async () => {
    const illegal = ALL_STATES.flatMap((from) =>
      ALL_STATES.filter((to) => from !== to && !canTransition(from, to)).map(
        (to) => [from, to] as const,
      ),
    );

    // Guards against the matrix silently becoming permissive.
    expect(illegal.length).toBeGreaterThan(50);

    const booking = await createBooking("IN_REVIEW");
    for (const [from, to] of illegal.filter(([source]) => source === "IN_REVIEW")) {
      await expect(
        transitionBooking({
          bookingRequestId: booking.id,
          to,
          actorUserId: null,
          reason: "attempted anyway",
        }),
      ).rejects.toMatchObject({ code: "illegal_transition" });
      expect(from).toBe("IN_REVIEW");
    }

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }),
    ).resolves.toMatchObject({ state: "IN_REVIEW" });
  });

  it("writes exactly one attributed audit row per transition", async () => {
    const booking = await createBooking("IN_REVIEW");
    const operator = await db.user.create({
      data: {
        email: `operator-${Date.now()}@example.test`,
        normalizedEmail: `operator-${Date.now()}@example.test`,
        status: "ACTIVE",
      },
    });

    try {
      await transitionBooking({
        bookingRequestId: booking.id,
        to: "APPROVED",
        actorUserId: operator.id,
      });
      await transitionBooking({
        bookingRequestId: booking.id,
        to: "AWAITING_PAYMENT",
        actorUserId: operator.id,
      });

      const events = await db.bookingAuditEvent.findMany({
        where: { bookingRequestId: booking.id },
        orderBy: { createdAt: "asc" },
      });

      expect(events).toHaveLength(2);
      expect(events.map((event) => [event.fromState, event.toState])).toEqual([
        ["IN_REVIEW", "APPROVED"],
        ["APPROVED", "AWAITING_PAYMENT"],
      ]);
      expect(events.every((event) => event.actorUserId === operator.id)).toBe(true);
    } finally {
      await db.user.delete({ where: { id: operator.id } });
    }
  });

  it("leaves no audit row when the transition is refused", async () => {
    const booking = await createBooking("IN_REVIEW");

    await expect(
      transitionBooking({
        bookingRequestId: booking.id,
        to: "COMPLETED",
        actorUserId: null,
      }),
    ).rejects.toBeInstanceOf(BookingTransitionError);

    await expect(
      db.bookingAuditEvent.count({ where: { bookingRequestId: booking.id } }),
    ).resolves.toBe(0);
  });

  it("requires a reason to reject or cancel, and stores it", async () => {
    const booking = await createBooking("IN_REVIEW");

    await expect(
      transitionBooking({
        bookingRequestId: booking.id,
        to: "REJECTED",
        actorUserId: null,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "reason_required" });

    await transitionBooking({
      bookingRequestId: booking.id,
      to: "REJECTED",
      actorUserId: null,
      reason: "  dates no longer available  ",
    });

    await expect(
      db.bookingAuditEvent.findFirstOrThrow({
        where: { bookingRequestId: booking.id },
      }),
    ).resolves.toMatchObject({ reason: "dates no longer available" });
  });

  it("refuses a decision taken against a stale state", async () => {
    const booking = await createBooking("IN_REVIEW");
    await transitionBooking({
      bookingRequestId: booking.id,
      to: "APPROVED",
      actorUserId: null,
    });

    await expect(
      transitionBooking({
        bookingRequestId: booking.id,
        to: "REJECTED",
        actorUserId: null,
        reason: "second operator, stale screen",
        expectedFrom: "IN_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "state_changed" });

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } }),
    ).resolves.toMatchObject({ state: "APPROVED" });
  });

  it("refuses to move an unknown booking", async () => {
    await expect(
      transitionBooking({
        bookingRequestId: "missing-booking-id",
        to: "IN_REVIEW",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: "unknown_booking" });
  });

  it("treats the closing states as terminal", () => {
    for (const state of ["COMPLETED", "REJECTED", "EXPIRED", "CANCELLED"] as const) {
      expect(isTerminal(state)).toBe(true);
    }
    for (const state of ["IN_REVIEW", "APPROVED"] as const) {
      expect(isTerminal(state)).toBe(false);
    }
  });
});
