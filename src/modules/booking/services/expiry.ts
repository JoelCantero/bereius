import "server-only";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ensureFreshBankEvidenceForExpiry } from "@/modules/banking/services/expiry";
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

/** Expires due bookings only after a fresh, complete bank scan. */
export async function expireUnpaidBookings(
  now: Date = new Date(),
): Promise<ExpirySummary> {
  const expiryAttemptStartedAt = now;
  const due = await db.bookingRequest.findMany({
    where: {
      state: "AWAITING_PAYMENT",
      paymentDueAt: { lte: now },
    },
    select: { id: true },
  });

  const summary: ExpirySummary = { examined: due.length, expired: 0 };
  if (due.length === 0) return summary;

  const evidence = await ensureFreshBankEvidenceForExpiry(
    expiryAttemptStartedAt,
    { clock: () => now },
  );
  if (!evidence.ready) {
    logger.warn(
      {
        event: "booking_expiry_deferred",
        examined: summary.examined,
        reason: evidence.reason,
      },
      "booking expiry deferred without fresh bank evidence",
    );
    return summary;
  }

  await db.$transaction(async (transaction) => {
    const verifiedEvidence = await transaction.bankSyncRun.findFirst({
      where: {
        id: evidence.runId,
        status: "SUCCEEDED",
        startedAt: { gte: expiryAttemptStartedAt },
        exhaustedAt: { not: null },
        account: { active: true },
      },
      select: { id: true },
    });
    if (!verifiedEvidence) return;

    for (const candidate of due) {
      const booking = await transaction.bookingRequest.findFirst({
        where: {
          id: candidate.id,
          state: "AWAITING_PAYMENT",
          paymentDueAt: { lte: now },
          bankReconciliationProposals: {
            none: { status: "PENDING" },
          },
        },
        select: { id: true },
      });
      if (!booking) continue;

      await transitionBooking(
        {
          bookingRequestId: booking.id,
          to: "EXPIRED",
          actorUserId: null,
          expectedFrom: "AWAITING_PAYMENT",
        },
        transaction,
      );
      summary.expired += 1;
    }
  });

  logger.info({ event: "booking_expiry_run", ...summary }, "booking expiry completed");

  return summary;
}
