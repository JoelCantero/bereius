import "server-only";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { paymentDeadlineFrom } from "@/modules/booking/services/expiry";
import { transitionBooking } from "@/modules/booking/services/lifecycle";
import { queueBookingMail } from "@/modules/booking/services/mail";
import { enqueueQuote } from "@/modules/booking/services/quoting";

export interface DecisionCommand {
  bookingRequestId: string;
  actorUserId: string;
  reason?: string;
  /** The state the operator saw, so a stale screen cannot overwrite a decision. */
  expectedFrom?: "IN_REVIEW";
}

async function notify(
  bookingRequestId: string,
  event: string,
  subject: string,
  text: string,
): Promise<void> {
  const booking = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    select: { customer: { select: { email: true } } },
  });
  if (!booking) return;

  await queueBookingMail(`${event}:${bookingRequestId}`, {
    to: booking.customer.email,
    subject,
    text,
  });
}

/**
 * Approves a booking and queues the Holded work.
 *
 * Approving is the act of asking for the deposit, so the request goes straight
 * to awaiting payment. The decision is a local write and the external calls go
 * to the outbox, so an approval is never lost because Holded was unreachable.
 */
export async function approveBooking(command: DecisionCommand): Promise<void> {
  await transitionBooking({
    bookingRequestId: command.bookingRequestId,
    to: "AWAITING_PAYMENT",
    actorUserId: command.actorUserId,
    expectedFrom: command.expectedFrom ?? "IN_REVIEW",
  });

  await db.bookingRequest.update({
    where: { id: command.bookingRequestId },
    data: { paymentDueAt: paymentDeadlineFrom(new Date()) },
  });

  await enqueueQuote(command.bookingRequestId);

  logger.info(
    { event: "booking_approved", bookingRequestId: command.bookingRequestId },
    "booking approved",
  );
}

export async function rejectBooking(command: DecisionCommand): Promise<void> {
  const result = await transitionBooking({
    bookingRequestId: command.bookingRequestId,
    to: "REJECTED",
    actorUserId: command.actorUserId,
    reason: command.reason,
    expectedFrom: command.expectedFrom,
  });

  // The n8n flow left this branch unconnected, so a rejected request simply
  // vanished and the requester was never told.
  await notify(
    command.bookingRequestId,
    "rejected",
    "Your booking request",
    `We are sorry: we cannot confirm your booking. ${command.reason ?? ""}`.trim(),
  );

  logger.info(
    { event: "booking_rejected", bookingRequestId: result.bookingRequestId },
    "booking rejected",
  );
}

export async function cancelBooking(command: DecisionCommand): Promise<void> {
  await transitionBooking({
    bookingRequestId: command.bookingRequestId,
    to: "CANCELLED",
    actorUserId: command.actorUserId,
    reason: command.reason,
  });

  await notify(
    command.bookingRequestId,
    "cancelled",
    "Your booking has been cancelled",
    `Your booking has been cancelled. ${command.reason ?? ""}`.trim(),
  );
}

export interface RecordPaymentCommand {
  bookingRequestId: string;
  actorUserId: string;
  amountCents: number;
  receivedAt: Date;
  reference?: string | null;
}

export class PaymentError extends Error {
  constructor(
    readonly code: "unknown_booking" | "amount_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

/**
 * Records a received transfer and confirms the booking.
 *
 * Strict by decision: the amount must equal the advance plus the deposit to the
 * cent. Anything else is left for manual review rather than quietly confirming
 * a booking that is still owed money.
 */
export async function recordPayment(command: RecordPaymentCommand): Promise<void> {
  const booking = await db.bookingRequest.findUnique({
    where: { id: command.bookingRequestId },
    select: { id: true, advanceCents: true, depositCents: true },
  });

  if (!booking) {
    throw new PaymentError("unknown_booking", "Booking request not found");
  }

  const expected = (booking.advanceCents ?? 0) + (booking.depositCents ?? 0);
  if (expected === 0 || command.amountCents !== expected) {
    throw new PaymentError(
      "amount_mismatch",
      "The transfer does not match the amount required to confirm this booking",
    );
  }

  await db.payment.create({
    data: {
      bookingRequestId: booking.id,
      amountCents: command.amountCents,
      receivedAt: command.receivedAt,
      reference: command.reference ?? null,
      recordedById: command.actorUserId,
    },
  });

  await transitionBooking({
    bookingRequestId: booking.id,
    to: "CONFIRMED",
    actorUserId: command.actorUserId,
    expectedFrom: "AWAITING_PAYMENT",
  });

  await notify(
    booking.id,
    "confirmed",
    "Your booking is confirmed",
    "We have received your payment and your booking is confirmed.",
  );

  logger.info(
    { event: "booking_confirmed", bookingRequestId: booking.id },
    "booking confirmed after payment",
  );
}
