import { z } from "zod";

export const HOLDED_TREASURY_PAGE_LIMIT = 100;
export const HOLDED_RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const HOLDED_REQUEST_TIMEOUT_MS = 15_000;
export const BANK_MOVEMENTS_PAGE_SIZE = 50;
export const BANK_MOVEMENT_NARRATIVE_LIMIT = 2_000;
export const BANK_MOVEMENT_STATUS_LIMIT = 64;
export const BANK_MOVEMENT_QUERY_LIMIT = 100;
export const BANK_PAYMENT_CANDIDATE_LIMIT = 25;
export const BANK_ACCOUNT_NAME_LIMIT = 140;
export const BANK_RETENTION_DAYS = 90;
export const BANK_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const BANK_SYNC_SWEEP_INTERVAL_MS = 60_000;
export const BANK_SYNC_LEASE_MS = 2 * 60_000;
export const BANK_SYNC_MAX_ATTEMPTS = 6;
export const BANK_SYNC_INITIAL_RETRY_MS = 30_000;
export const BANK_SYNC_MAX_RETRY_MS = 60 * 60_000;
export const BANK_SYNC_MANUAL_COOLDOWN_MS = 60_000;
export const VERIFIED_BANK_CURRENCY = "EUR";

export const BANK_MOVEMENT_DIRECTIONS = ["INCOME", "EXPENSE"] as const;
export const BANK_SYNC_TRIGGERS = ["SCHEDULED", "MANUAL", "EXPIRY"] as const;
export const BANK_SYNC_STATUSES = [
  "QUEUED",
  "RUNNING",
  "RETRYING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
] as const;
export const BANK_SYNC_NONTERMINAL_STATUSES = [
  "QUEUED",
  "RUNNING",
  "RETRYING",
] as const;
export const BANK_SYNC_TERMINAL_STATUSES = ["SUCCEEDED", "PARTIAL", "FAILED"] as const;
export const BANK_SYNC_INCIDENT_CODES = [
  "PROVIDER_UNAUTHORIZED",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REQUEST_REJECTED",
  "RESPONSE_TOO_LARGE",
  "MALFORMED_PAGE",
  "MISSING_CURSOR",
  "REPEATED_CURSOR",
  "INVALID_MOVEMENT_ID",
  "ACCOUNT_MISMATCH",
  "INVALID_BOOKING_DATE",
  "INVALID_VALUE_DATE",
  "INVALID_AMOUNT",
  "ZERO_AMOUNT",
  "INVALID_CURRENCY",
  "DESCRIPTION_TOO_LONG",
  "CONFIRMED_MATCH_CHANGED",
] as const;
export const BANK_RECONCILIATION_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "DISMISSED",
  "INVALIDATED",
] as const;

export const bankMovementDirectionSchema = z.enum(BANK_MOVEMENT_DIRECTIONS);
export const bankSyncTriggerSchema = z.enum(BANK_SYNC_TRIGGERS);
export const bankSyncStatusSchema = z.enum(BANK_SYNC_STATUSES);
export const bankSyncIncidentCodeSchema = z.enum(BANK_SYNC_INCIDENT_CODES);
export const bankReconciliationStatusSchema = z.enum(BANK_RECONCILIATION_STATUSES);

export type BankMovementDirection = z.infer<typeof bankMovementDirectionSchema>;
export type BankSyncTrigger = z.infer<typeof bankSyncTriggerSchema>;
export type BankSyncStatus = z.infer<typeof bankSyncStatusSchema>;
export type BankSyncIncidentCode = z.infer<typeof bankSyncIncidentCodeSchema>;
export type BankReconciliationStatus = z.infer<typeof bankReconciliationStatusSchema>;

export const holdedProviderIdSchema = z
  .string()
  .regex(/^[0-9a-f]{24}$/iu, "Expected a 24-character hexadecimal identifier");
export const retainedCurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/u, "Expected an uppercase three-letter currency code");
export const holdedAmountSchema = z
  .string()
  .regex(/^-?\d+\.\d{2}$/u, "Expected a decimal amount with two fractional digits");

function isRealCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

export const bankCalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD date")
  .refine(isRealCalendarDate, "Not a real calendar date");

export const nonFutureBankDateSchema = bankCalendarDateSchema.refine(
  (value) => value <= new Date().toISOString().slice(0, 10),
  "Date must not be in the future",
);

export const holdedBankDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
    "Expected an ISO datetime with an explicit offset",
  )
  .refine((value) => isRealCalendarDate(value.slice(0, 10)), "Not a real calendar date")
  .refine((value) => Number.isFinite(Date.parse(value)), "Not a real datetime");

const nullableTrimmedText = (limit: number) =>
  z
    .string()
    .trim()
    .max(limit)
    .nullable()
    .optional()
    .transform((value) => value || null);

export const holdedTreasuryAccountSchema = z.object({
  id: holdedProviderIdSchema,
  name: z.string().trim().min(1).max(BANK_ACCOUNT_NAME_LIMIT),
  currency: retainedCurrencySchema,
  archived: z.boolean(),
});

export const holdedBankMovementPayloadSchema = z.object({
  id: z.unknown().optional(),
  banking_account_id: z.unknown().optional(),
  booking_date: z.unknown().optional(),
  value_date: z.unknown().optional(),
  description: z.unknown().optional(),
  amount: z.unknown().optional(),
  currency: z.unknown().optional(),
  status: z.unknown().optional(),
});

export const holdedBankMovementSchema = z.object({
  id: holdedProviderIdSchema,
  banking_account_id: holdedProviderIdSchema,
  booking_date: holdedBankDateTimeSchema,
  value_date: holdedBankDateTimeSchema.nullable().optional(),
  description: nullableTrimmedText(BANK_MOVEMENT_NARRATIVE_LIMIT),
  amount: holdedAmountSchema,
  currency: z.literal(VERIFIED_BANK_CURRENCY),
  status: nullableTrimmedText(BANK_MOVEMENT_STATUS_LIMIT),
});

function holdedPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z
    .object({
      items: z.array(itemSchema).max(HOLDED_TREASURY_PAGE_LIMIT),
      has_more: z.boolean(),
      cursor: z.string().min(1).nullable(),
    })
    .superRefine((page, context) => {
      if (page.has_more && page.cursor === null) {
        context.addIssue({
          code: "custom",
          path: ["cursor"],
          message: "A nonterminal page requires a cursor",
        });
      }
    });
}

export const holdedTreasuryAccountPageSchema = holdedPageSchema(
  holdedTreasuryAccountSchema,
);
export const holdedBankMovementPageSchema = holdedPageSchema(
  holdedBankMovementPayloadSchema,
);

const optionalFilterDate = z.union([bankCalendarDateSchema, z.literal("")]).optional();
const optionalFilterAccount = z.union([holdedProviderIdSchema, z.literal("")]).optional();
const optionalFilterCurrency = z.union([retainedCurrencySchema, z.literal("")]).optional();
const filterQuerySchema = z
  .string()
  .transform((value) => value.trim().replaceAll(/\s+/gu, " "))
  .pipe(z.string().max(BANK_MOVEMENT_QUERY_LIMIT))
  .optional()
  .default("");
const filterPageSchema = z
  .union([z.string().regex(/^[1-9]\d*$/u), z.number().int().positive().safe()])
  .transform(Number)
  .optional()
  .default(1);

export const bankMovementFiltersSchema = z
  .object({
    direction: z.enum(["all", "income", "expense"]).optional().default("all"),
    from: optionalFilterDate,
    to: optionalFilterDate,
    account: optionalFilterAccount,
    currency: optionalFilterCurrency,
    q: filterQuerySchema,
    page: filterPageSchema,
  })
  .strict()
  .transform((filters) => ({
    ...filters,
    from: filters.from || undefined,
    to: filters.to || undefined,
    account: filters.account || undefined,
    currency: filters.currency || undefined,
  }))
  .refine((filters) => !filters.from || !filters.to || filters.from <= filters.to, {
    path: ["to"],
    message: "End date must not precede start date",
  });

export const saveTreasuryAccountInputSchema = z
  .object({
    holdedAccountId: holdedProviderIdSchema,
    importStartDate: nonFutureBankDateSchema,
  })
  .strict();

export const requestBankSyncInputSchema = z
  .object({
    retryRunId: z.string().cuid().optional(),
  })
  .strict();

export const proposalActionInputSchema = z
  .object({
    proposalId: z.string().cuid(),
  })
  .strict();

export const bookingPaymentCandidateActionInputSchema = z
  .object({
    bookingRequestId: z.string().cuid(),
    movementId: z.string().cuid(),
  })
  .strict();

export type HoldedTreasuryAccount = z.infer<typeof holdedTreasuryAccountSchema>;
export type HoldedBankMovementPayload = z.infer<typeof holdedBankMovementPayloadSchema>;
export type HoldedBankMovement = z.infer<typeof holdedBankMovementSchema>;
export type BankMovementFilters = z.infer<typeof bankMovementFiltersSchema>;
export type SaveTreasuryAccountInput = z.infer<typeof saveTreasuryAccountInputSchema>;
export type RequestBankSyncInput = z.infer<typeof requestBankSyncInputSchema>;
export type ProposalActionInput = z.infer<typeof proposalActionInputSchema>;
export type BookingPaymentCandidateActionInput = z.infer<
  typeof bookingPaymentCandidateActionInputSchema
>;