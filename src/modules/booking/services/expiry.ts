import "server-only";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { transitionBooking } from "@/modules/booking/services/lifecycle";

export const PAYMENT_WINDOW_DAYS = 3;

export function paymentDeadlineFrom(approvedAt: Date): Date {
  const deadline = new Date(approvedAt);
  deadline.setUTCDate(deadline.getUTCDate() + PAYMENT_WINDOW_DAYS);
  return deadline;
}

export interface ExpirySummary {
  examined: number;
  expired: number;
}

/**
 * Expires bookings whose payment window has closed, releasing their dates.
 *
 * Phase 2 adds a final bank poll before this runs, so a transfer that arrived
 * shortly before the deadline is never missed. Until then the window is
 * evaluated against payments an operator has already recorded.
 */
export async function expireUnpaidBookings(
  now: Date = new Date(),
): Promise<ExpirySummary> {
  const due = await db.bookingRequest.findMany({
    where: {
      state: "AWAITING_PAYMENT",
      paymentDueAt: { lte: now },
    },
    select: { id: true },
  });

  const summary: ExpirySummary = { examined: due.length, expired: 0 };

  for (const booking of due) {
    try {
      await transitionBooking({
        bookingRequestId: booking.id,
        to: "EXPIRED",
        actorUserId: null,
        expectedFrom: "AWAITING_PAYMENT",
      });
      summary.expired += 1;
    } catch (error) {
      // A booking confirmed between the query and the transition is not a
      // failure: it simply no longer qualifies.
      logger.warn(
        {
          event: "booking_expiry_skipped",
          bookingRequestId: booking.id,
          reason: error instanceof Error ? error.message : "unknown",
        },
        "booking expiry skipped a request that changed state",
      );
    }
  }

  logger.info({ event: "booking_expiry_run", ...summary }, "booking expiry completed");

  return summary;
}
