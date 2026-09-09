import { z } from "zod";

import type { BoardType } from "@/generated/prisma/enums";

/**
 * Gravity Forms field identifiers for form 2, "Formulari de reserva".
 *
 * Mapped by identifier rather than by label: renaming a label in the form
 * builder must not silently break intake, which is how the retired n8n webhook
 * was wired.
 *
 * The form also submits computed nights (47), units (39), total (52) and SKU
 * (51). They are deliberately absent here: they are client-supplied, and live
 * entries show them to be wrong — a two-night stay arrives with `Nits = 1` and
 * units equal to the headcount. Everything billable is recomputed server-side.
 */
export const GRAVITY_FORM_FIELDS = {
  firstName: "61",
  lastName: "63",
  organisation: "64",
  taxId: "65",
  email: "66",
  phone: "67",
  addressLine: "68.1",
  city: "68.3",
  province: "68.4",
  postalCode: "68.5",
  country: "68.6",
  headcount: "73",
  boardType: "74",
  startDate: "30",
  endDate: "31",
  houseRulesConsent: "38.1",
} as const;

const BOARD_TYPE_BY_FORM_VALUE: Readonly<Record<string, BoardType>> = {
  pc: "FULL_BOARD",
  dc: "SELF_CATERING",
};

/** Gravity Forms sends absent optional values as an empty string. */
const optionalText = z
  .unknown()
  .transform((value) => (typeof value === "string" ? value.trim() : ""))
  .transform((value) => (value.length === 0 ? null : value));

const requiredText = z
  .unknown()
  .transform((value) => (typeof value === "string" ? value.trim() : ""))
  .pipe(z.string().min(1));

const calendarDate = z
  .unknown()
  .transform((value) => (typeof value === "string" ? value.trim() : ""))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD date"))
  .transform((value, ctx) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: "custom", message: "Not a real calendar date" });
      return z.NEVER;
    }
    return parsed;
  });

const positiveCount = z
  .unknown()
  .transform((value) => (typeof value === "string" ? value.trim() : value))
  .pipe(z.coerce.number().int().positive());

const boardType = z
  .unknown()
  .transform((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
  .transform((value, ctx) => {
    const mapped = BOARD_TYPE_BY_FORM_VALUE[value];
    if (!mapped) {
      ctx.addIssue({ code: "custom", message: "Unknown board type" });
      return z.NEVER;
    }
    return mapped;
  });

const F = GRAVITY_FORM_FIELDS;

const submissionSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    date_created: requiredText,
    [F.firstName]: requiredText,
    [F.lastName]: requiredText,
    [F.organisation]: optionalText,
    [F.taxId]: requiredText,
    [F.email]: requiredText.pipe(z.email()),
    [F.phone]: optionalText,
    [F.addressLine]: optionalText,
    [F.city]: optionalText,
    [F.province]: optionalText,
    [F.postalCode]: optionalText,
    [F.country]: optionalText,
    [F.headcount]: positiveCount,
    [F.boardType]: boardType,
    [F.startDate]: calendarDate,
    [F.endDate]: calendarDate,
  })
  .transform((entry) => ({
    entryId: entry.id,
    submittedAt: entry.date_created,
    customer: {
      // The organisation is the billed party when present, matching how the
      // Holded contact is named.
      name:
        entry[F.organisation] ??
        `${entry[F.firstName]} ${entry[F.lastName]}`.trim(),
      taxId: entry[F.taxId].toUpperCase().replaceAll(/\s+/gu, ""),
      email: entry[F.email].toLowerCase(),
      phone: entry[F.phone],
      addressLine: entry[F.addressLine],
      city: entry[F.city],
      province: entry[F.province],
      postalCode: entry[F.postalCode],
      country: entry[F.country],
    },
    stay: {
      headcount: entry[F.headcount],
      boardType: entry[F.boardType],
      startDate: entry[F.startDate],
      endDate: entry[F.endDate],
    },
  }));

export type BookingSubmission = z.infer<typeof submissionSchema>;

export type ParseSubmissionResult =
  | { ok: true; submission: BookingSubmission }
  | { ok: false; entryId: string | null; issues: string[] };

/**
 * Never throws: a malformed entry must be recorded and skipped without
 * stopping the rest of the batch.
 */
export function parseBookingSubmission(entry: unknown): ParseSubmissionResult {
  const parsed = submissionSchema.safeParse(entry);

  if (parsed.success) {
    return { ok: true, submission: parsed.data };
  }

  const entryId =
    typeof entry === "object" && entry !== null && "id" in entry
      ? String((entry as { id: unknown }).id)
      : null;

  return {
    ok: false,
    entryId,
    // Paths only: an issue message must never echo a submitted value.
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`,
    ),
  };
}
