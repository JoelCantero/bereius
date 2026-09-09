import "server-only";

import { BookingState } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

/**
 * Every legal move. A state absent from a source's list is unreachable from it,
 * which is what makes an approval impossible to skip.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<BookingState, readonly BookingState[]>> = {
  RECEIVED: ["IN_REVIEW", "REJECTED"],
  IN_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["AWAITING_PAYMENT", "CANCELLED"],
  AWAITING_PAYMENT: ["CONFIRMED", "EXPIRED", "CANCELLED"],
  CONFIRMED: ["INVOICED", "CANCELLED"],
  INVOICED: ["COMPLETED"],
  COMPLETED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/** Transitions a person must justify, because they end or undo a commitment. */
const REASON_REQUIRED: ReadonlySet<BookingState> = new Set<BookingState>([
  "REJECTED",
  "CANCELLED",
]);

export class BookingTransitionError extends Error {
  constructor(
    readonly code:
      | "unknown_booking"
      | "illegal_transition"
      | "reason_required"
      | "state_changed",
    message: string,
  ) {
    super(message);
    this.name = "BookingTransitionError";
  }
}

export function canTransition(from: BookingState, to: BookingState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function requiresReason(to: BookingState): boolean {
  return REASON_REQUIRED.has(to);
}

export function isTerminal(state: BookingState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

export interface TransitionCommand {
  bookingRequestId: string;
  to: BookingState;
  /** Null for scheduled jobs; a user id when a person decided. */
  actorUserId: string | null;
  reason?: string;
  /** Guards against two operators deciding the same request concurrently. */
  expectedFrom?: BookingState;
}

export interface TransitionResult {
  bookingRequestId: string;
  from: BookingState;
  to: BookingState;
}

/**
 * Moves a booking and records why, atomically. The audit row and the state
 * change share one transaction, so a booking can never reach a state without
 * leaving evidence of who put it there.
 */
export async function transitionBooking(
  command: TransitionCommand,
): Promise<TransitionResult> {
  const reason = command.reason?.trim();

  if (requiresReason(command.to) && !reason) {
    throw new BookingTransitionError(
      "reason_required",
      `A reason is required to move a booking to ${command.to}`,
    );
  }

  return db.$transaction(async (tx) => {
    const booking = await tx.bookingRequest.findUnique({
      where: { id: command.bookingRequestId },
      select: { id: true, state: true },
    });

    if (!booking) {
      throw new BookingTransitionError(
        "unknown_booking",
        "Booking request not found",
      );
    }

    if (command.expectedFrom !== undefined && booking.state !== command.expectedFrom) {
      throw new BookingTransitionError(
        "state_changed",
        `Booking is in ${booking.state}, not ${command.expectedFrom}`,
      );
    }

    if (!canTransition(booking.state, command.to)) {
      throw new BookingTransitionError(
        "illegal_transition",
        `Cannot move a booking from ${booking.state} to ${command.to}`,
      );
    }

    // Conditioned on the observed state so a concurrent transition loses rather
    // than silently overwriting.
    const updated = await tx.bookingRequest.updateMany({
      where: { id: booking.id, state: booking.state },
      data: {
        state: command.to,
        ...(command.actorUserId !== null || reason
          ? {
              decidedAt: new Date(),
              decidedById: command.actorUserId,
              decisionReason: reason ?? null,
            }
          : {}),
      },
    });

    if (updated.count !== 1) {
      throw new BookingTransitionError(
        "state_changed",
        "Booking changed state while the transition was being applied",
      );
    }

    await tx.bookingAuditEvent.create({
      data: {
        bookingRequestId: booking.id,
        actorUserId: command.actorUserId,
        fromState: booking.state,
        toState: command.to,
        reason: reason ?? null,
      },
    });

    return { bookingRequestId: booking.id, from: booking.state, to: command.to };
  });
}
