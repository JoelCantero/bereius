import "server-only";

import type {
  BankMovementDirection,
  BankSyncIncidentCode,
  HoldedBankMovementPayload,
} from "@/modules/banking/schema";
import {
  BANK_MOVEMENT_NARRATIVE_LIMIT,
  BANK_MOVEMENT_STATUS_LIMIT,
  VERIFIED_BANK_CURRENCY,
  holdedAmountSchema,
  holdedBankDateTimeSchema,
  holdedProviderIdSchema,
} from "@/modules/banking/schema";

export interface NormalizedBankMovement {
  holdedMovementId: string;
  bookingDate: Date;
  valueDate: Date | null;
  narrative: string | null;
  amountMinor: bigint;
  currency: string;
  providerStatus: string | null;
  direction: BankMovementDirection;
}

export type BankMovementParseResult =
  | { ok: true; movement: NormalizedBankMovement }
  | {
      ok: false;
      incident: {
        code: BankSyncIncidentCode;
        holdedMovementId: string | null;
      };
    };

const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");
const MIN_POSTGRES_BIGINT = BigInt("-9223372036854775808");

function rejected(
  code: BankSyncIncidentCode,
  holdedMovementId: string | null,
): BankMovementParseResult {
  return { ok: false, incident: { code, holdedMovementId } };
}

function bankDate(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function optionalText(value: unknown, limit: number) {
  if (value === undefined || value === null) return { ok: true, value: null } as const;
  if (typeof value !== "string") return { ok: false } as const;
  const trimmed = value.trim();
  if (trimmed.length > limit) return { ok: false } as const;
  return { ok: true, value: trimmed || null } as const;
}

function parseMinorUnits(value: string) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [major, minor] = unsigned.split(".");
  const amount = BigInt(major) * BigInt(100) + BigInt(minor);
  return negative ? -amount : amount;
}

export function parseHoldedBankMovement(
  payload: HoldedBankMovementPayload,
  expectedAccountId: string,
): BankMovementParseResult {
  const parsedId = holdedProviderIdSchema.safeParse(payload.id);
  if (!parsedId.success) return rejected("INVALID_MOVEMENT_ID", null);
  const holdedMovementId = parsedId.data;

  const parsedAccount = holdedProviderIdSchema.safeParse(payload.banking_account_id);
  if (!parsedAccount.success || parsedAccount.data !== expectedAccountId) {
    return rejected("ACCOUNT_MISMATCH", holdedMovementId);
  }

  const parsedBookingDate = holdedBankDateTimeSchema.safeParse(payload.booking_date);
  if (!parsedBookingDate.success) {
    return rejected("INVALID_BOOKING_DATE", holdedMovementId);
  }

  let valueDate: Date | null = null;
  if (payload.value_date !== undefined && payload.value_date !== null) {
    const parsedValueDate = holdedBankDateTimeSchema.safeParse(payload.value_date);
    if (!parsedValueDate.success) {
      return rejected("INVALID_VALUE_DATE", holdedMovementId);
    }
    valueDate = bankDate(parsedValueDate.data);
  }

  const parsedAmount = holdedAmountSchema.safeParse(payload.amount);
  if (!parsedAmount.success) return rejected("INVALID_AMOUNT", holdedMovementId);

  let amountMinor: bigint;
  try {
    amountMinor = parseMinorUnits(parsedAmount.data);
  } catch {
    return rejected("INVALID_AMOUNT", holdedMovementId);
  }
  if (amountMinor === BigInt(0)) return rejected("ZERO_AMOUNT", holdedMovementId);
  if (amountMinor < MIN_POSTGRES_BIGINT || amountMinor > MAX_POSTGRES_BIGINT) {
    return rejected("INVALID_AMOUNT", holdedMovementId);
  }

  if (payload.currency !== VERIFIED_BANK_CURRENCY) {
    return rejected("INVALID_CURRENCY", holdedMovementId);
  }

  const narrative = optionalText(payload.description, BANK_MOVEMENT_NARRATIVE_LIMIT);
  if (!narrative.ok) {
    return rejected(
      typeof payload.description === "string"
        ? "DESCRIPTION_TOO_LONG"
        : "MALFORMED_PAGE",
      holdedMovementId,
    );
  }

  const providerStatus = optionalText(payload.status, BANK_MOVEMENT_STATUS_LIMIT);
  if (!providerStatus.ok) return rejected("MALFORMED_PAGE", holdedMovementId);

  const direction: BankMovementDirection =
    amountMinor > BigInt(0) ? "INCOME" : "EXPENSE";

  return {
    ok: true,
    movement: {
      holdedMovementId,
      bookingDate: bankDate(parsedBookingDate.data),
      valueDate,
      narrative: narrative.value,
      amountMinor,
      currency: VERIFIED_BANK_CURRENCY,
      providerStatus: providerStatus.value,
      direction,
    },
  };
}