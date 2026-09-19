export interface PaymentMatchingBooking {
  state: string;
  decidedAt: Date | null;
  advanceCents: number | null;
  depositCents: number | null;
  documents: Array<{ documentNumber: string | null; issuedAt: Date }>;
}

export interface PaymentMatchingMovement {
  direction: string;
  amountMinor: bigint;
  currency: string;
  bookingDate: Date;
  narrative: string | null;
}

export const BOOKING_PAYMENT_TOLERANCE_PERCENT = 5;
const TOLERANCE_PERCENT = BigInt(BOOKING_PAYMENT_TOLERANCE_PERCENT);
const PERCENT_SCALE = BigInt(100);

export function expectedPaymentMinor(booking: PaymentMatchingBooking): bigint {
  return BigInt(booking.advanceCents ?? 0) + BigInt(booking.depositCents ?? 0);
}

export function paymentAmountBounds(expected: bigint): {
  minimum: bigint;
  maximum: bigint;
} {
  return {
    minimum:
      (expected * (PERCENT_SCALE - TOLERANCE_PERCENT) + PERCENT_SCALE - BigInt(1)) /
      PERCENT_SCALE,
    maximum: (expected * (PERCENT_SCALE + TOLERANCE_PERCENT)) / PERCENT_SCALE,
  };
}

function utcCalendarDate(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
    ),
  );
}

export function bookingPaymentStartDate(
  booking: PaymentMatchingBooking,
): Date | null {
  const value = booking.documents[0]?.issuedAt ?? booking.decidedAt;
  return value ? utcCalendarDate(value) : null;
}

export function estimateNumber(booking: PaymentMatchingBooking): string | null {
  const value = booking.documents[0]?.documentNumber;
  return value?.trim() ? value : null;
}

export function hasEstimateReference(
  narrative: string | null,
  documentNumber: string | null,
): boolean {
  return Boolean(
    narrative &&
      documentNumber &&
      narrative.toLocaleLowerCase().includes(documentNumber.toLocaleLowerCase()),
  );
}

export function isBookingPaymentCandidate(
  movement: PaymentMatchingMovement,
  booking: PaymentMatchingBooking,
): boolean {
  const paymentStartDate = bookingPaymentStartDate(booking);
  if (
    booking.state !== "AWAITING_PAYMENT" ||
    !paymentStartDate ||
    movement.direction !== "INCOME" ||
    movement.amountMinor <= BigInt(0) ||
    movement.currency !== "EUR" ||
    movement.bookingDate < paymentStartDate
  ) {
    return false;
  }

  const expected = expectedPaymentMinor(booking);
  if (expected <= BigInt(0)) return false;
  return isPaymentAmountWithinTolerance(movement.amountMinor, expected);
}

export function isPaymentAmountWithinTolerance(
  actual: bigint,
  expected: bigint,
): boolean {
  if (actual <= BigInt(0) || expected <= BigInt(0)) return false;
  const difference = actual >= expected ? actual - expected : expected - actual;
  return difference * PERCENT_SCALE <= expected * TOLERANCE_PERCENT;
}

export function isAutomaticReconciliationMatch(
  movement: PaymentMatchingMovement,
  booking: PaymentMatchingBooking,
): boolean {
  const documentNumber = estimateNumber(booking);
  return (
    isBookingPaymentCandidate(movement, booking) &&
    movement.amountMinor === expectedPaymentMinor(booking) &&
    documentNumber !== null &&
    movement.narrative?.includes(documentNumber) === true
  );
}