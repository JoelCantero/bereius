import { z } from "zod";

import type { BoardType } from "@/generated/prisma/enums";

/**
 * Stands in for a stored credential so the field looks filled without the
 * secret ever reaching the browser. Bullets cannot occur in a real credential,
 * so a submission carrying them means the operator left the field untouched.
 */
export const STORED_SECRET_PLACEHOLDER = "••••••••••••";

/** Distinguishes "leave the stored credential alone" from a genuine new one. */
export function submittedSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("•")) return undefined;
  return trimmed;
}

/**
 * Which Gravity Forms field holds each piece of a booking request.
 *
 * Mapped by identifier rather than by label, so renaming a label in the form
 * builder cannot silently break intake, which is how the retired n8n webhook
 * was wired. Administrators change these from the settings screen when the form
 * is rebuilt.
 */
export const GRAVITY_FORM_FIELD_KEYS = [
  "firstName",
  "lastName",
  "organisation",
  "taxId",
  "email",
  "phone",
  "addressLine",
  "city",
  "province",
  "postalCode",
  "country",
  "headcount",
  "boardType",
  "startDate",
  "endDate",
] as const;

export type GravityFormFieldKey = (typeof GRAVITY_FORM_FIELD_KEYS)[number];
export type GravityFormFieldMap = Record<GravityFormFieldKey, string>;

/** Form 2, "Formulari de reserva", as published on berea.cat. */
export const DEFAULT_GRAVITY_FORM_FIELDS: GravityFormFieldMap = {
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
};

/**
 * The form also submits computed nights, units, total and SKU. They are
 * deliberately unmappable: they are client-supplied, and live entries show them
 * to be wrong — a two-night stay arrives with one night and units equal to the
 * headcount. Everything billable is recomputed server-side.
 */
export const gravityFormFieldMapSchema = z
  .object(
    Object.fromEntries(
      GRAVITY_FORM_FIELD_KEYS.map((key) => [
        key,
        z.string().regex(/^\d+(?:\.\d+)?$/u, "Expected a Gravity Forms field id"),
      ]),
    ) as Record<GravityFormFieldKey, z.ZodString>,
  )
  .strict();

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
  // Gravity Forms does not pad the month or the day, so `2027-7-4` is normal.
  .pipe(z.string().regex(/^\d{4}-\d{1,2}-\d{1,2}$/u, "Expected a YYYY-M-D date"))
  .transform((value, ctx) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    // Date.UTC rolls a 31st of February over into March rather than refusing.
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
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

export interface BookingSubmission {
  entryId: string;
  submittedAt: string;
  customer: {
    name: string;
    taxId: string;
    email: string;
    phone: string | null;
    addressLine: string | null;
    city: string | null;
    province: string | null;
    postalCode: string | null;
    country: string | null;
  };
  stay: {
    headcount: number;
    boardType: BoardType;
    startDate: Date;
    endDate: Date;
  };
}

function buildSubmissionSchema(fields: GravityFormFieldMap) {
  return z
    .object({
      id: z.union([z.string(), z.number()]).transform(String),
      date_created: requiredText,
      [fields.firstName]: requiredText,
      [fields.lastName]: requiredText,
      [fields.organisation]: optionalText,
      [fields.taxId]: requiredText,
      [fields.email]: requiredText.pipe(z.email()),
      [fields.phone]: optionalText,
      [fields.addressLine]: optionalText,
      [fields.city]: optionalText,
      [fields.province]: optionalText,
      [fields.postalCode]: optionalText,
      [fields.country]: optionalText,
      [fields.headcount]: positiveCount,
      [fields.boardType]: boardType,
      [fields.startDate]: calendarDate,
      [fields.endDate]: calendarDate,
    })
    .transform((entry): BookingSubmission => {
      const read = <T>(fieldId: string): T => (entry as Record<string, unknown>)[fieldId] as T;

      return {
        entryId: String(entry.id),
        submittedAt: String(entry.date_created),
        customer: {
          // The organisation is the billed party when present, matching how the
          // Holded contact is named.
          name:
            read<string | null>(fields.organisation) ??
            `${read<string>(fields.firstName)} ${read<string>(fields.lastName)}`.trim(),
          taxId: read<string>(fields.taxId).toUpperCase().replaceAll(/\s+/gu, ""),
          email: read<string>(fields.email).toLowerCase(),
          phone: read<string | null>(fields.phone),
          addressLine: read<string | null>(fields.addressLine),
          city: read<string | null>(fields.city),
          province: read<string | null>(fields.province),
          postalCode: read<string | null>(fields.postalCode),
          country: read<string | null>(fields.country),
        },
        stay: {
          headcount: read<number>(fields.headcount),
          boardType: read<BoardType>(fields.boardType),
          startDate: read<Date>(fields.startDate),
          endDate: read<Date>(fields.endDate),
        },
      };
    });
}

export type ParseSubmissionResult =
  | { ok: true; submission: BookingSubmission }
  | { ok: false; entryId: string | null; issues: string[] };

export interface BookingSubmissionParser {
  parse(entry: unknown): ParseSubmissionResult;
}

/** Built once per batch, because the schema depends on the configured map. */
export function createBookingSubmissionParser(
  fields: GravityFormFieldMap = DEFAULT_GRAVITY_FORM_FIELDS,
): BookingSubmissionParser {
  const schema = buildSubmissionSchema(fields);

  return {
    parse(entry) {
      const parsed = schema.safeParse(entry);

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
    },
  };
}
