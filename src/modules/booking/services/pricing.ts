import type { BoardType } from "@/generated/prisma/enums";

/** The house never bills fewer places than this, whatever the group size. */
export const BILLABLE_HEADCOUNT_FLOOR = 30;

/** Refundable security deposit, fixed at 200 EUR. */
export const SECURITY_DEPOSIT_CENTS = 20_000;

/** Share of the stay total payable up front to confirm a booking. */
export const ADVANCE_NUMERATOR = 3;
export const ADVANCE_DENOMINATOR = 10;

/** VAT rate applied to accommodation, as a percentage. */
export const VAT_PERCENT = 10;

export type HeadcountBand = "30" | "40" | "60" | "80";

const BOARD_TYPE_PREFIX: Readonly<Record<BoardType, string>> = {
  SELF_CATERING: "dc",
  FULL_BOARD: "pc",
};

export class BookingPricingError extends Error {
  constructor(
    readonly code: "invalid_stay" | "invalid_headcount" | "invalid_unit_price",
    message: string,
  ) {
    super(message);
    this.name = "BookingPricingError";
  }
}

/**
 * Nights between two calendar dates.
 *
 * Both arguments are calendar dates at UTC midnight, as stored by `@db.Date`.
 * The arithmetic reads UTC components on purpose: UTC has no daylight saving,
 * so a stay across a clock change cannot yield a fractional count the way the
 * retired workflow's millisecond subtraction did.
 */
export function countNights(startDate: Date, endDate: Date): number {
  const start = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  );
  const end = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate(),
  );

  const nights = (end - start) / 86_400_000;

  if (!Number.isInteger(nights) || nights < 1) {
    throw new BookingPricingError(
      "invalid_stay",
      "A stay must end at least one night after it starts",
    );
  }

  return nights;
}

export function billableHeadcount(headcount: number): number {
  if (!Number.isInteger(headcount) || headcount < 1) {
    throw new BookingPricingError(
      "invalid_headcount",
      "Headcount must be a positive whole number",
    );
  }
  return Math.max(headcount, BILLABLE_HEADCOUNT_FLOOR);
}

/**
 * Rate band. Derived from the submitted headcount rather than the billable one;
 * they only differ below the floor, which lands in the lowest band either way.
 */
export function resolveHeadcountBand(headcount: number): HeadcountBand {
  billableHeadcount(headcount);
  if (headcount <= 39) return "30";
  if (headcount <= 59) return "40";
  if (headcount <= 79) return "60";
  return "80";
}

export function resolveServiceSku(boardType: BoardType, headcount: number): string {
  return `${BOARD_TYPE_PREFIX[boardType]}${resolveHeadcountBand(headcount)}`;
}

export interface StayQuoteInput {
  boardType: BoardType;
  headcount: number;
  startDate: Date;
  endDate: Date;
  /** Gross price per person and night, read from the Holded service. */
  unitPriceCents: number;
}

export interface StayQuote {
  nights: number;
  billableHeadcount: number;
  /** Person-nights actually billed. */
  units: number;
  serviceSku: string;
  unitPriceCents: number;
  stayTotalCents: number;
  advanceCents: number;
  /** Advance excluding VAT, which is what an invoice line carries. */
  advanceNetCents: number;
  depositCents: number;
  /** What the customer must transfer to confirm: advance plus deposit. */
  amountToConfirmCents: number;
}

/**
 * Prices a stay in integer cents. Every division rounds explicitly here rather
 * than leaving a repeating decimal for the accounting system to interpret.
 */
export function quoteStay(input: StayQuoteInput): StayQuote {
  if (!Number.isInteger(input.unitPriceCents) || input.unitPriceCents < 0) {
    throw new BookingPricingError(
      "invalid_unit_price",
      "Unit price must be a whole number of cents",
    );
  }

  const nights = countNights(input.startDate, input.endDate);
  const billable = billableHeadcount(input.headcount);
  const units = nights * billable;
  const stayTotalCents = input.unitPriceCents * units;
  const advanceCents = Math.round(
    (stayTotalCents * ADVANCE_NUMERATOR) / ADVANCE_DENOMINATOR,
  );

  return {
    nights,
    billableHeadcount: billable,
    units,
    serviceSku: resolveServiceSku(input.boardType, input.headcount),
    unitPriceCents: input.unitPriceCents,
    stayTotalCents,
    advanceCents,
    advanceNetCents: Math.round((advanceCents * 100) / (100 + VAT_PERCENT)),
    depositCents: SECURITY_DEPOSIT_CENTS,
    amountToConfirmCents: advanceCents + SECURITY_DEPOSIT_CENTS,
  };
}
