import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  createGravityFormsClient,
  type GravityFormsClient,
} from "@/lib/gravity-forms/client";
import { logger } from "@/lib/logger";
import {
  createBookingSubmissionParser,
  DEFAULT_GRAVITY_FORM_FIELDS,
  type BookingSubmission,
  type GravityFormFieldMap,
} from "@/modules/booking/schema";
import { countNights } from "@/modules/booking/services/pricing";
import { resolveIntegration } from "@/modules/booking/services/settings";

export const INTAKE_SOURCE = "gravity-forms";

export interface IntakeSummary {
  read: number;
  created: number;
  /** Already imported: the entry resolves to an existing booking. */
  skipped: number;
  rejected: number;
  cursor: string | null;
}

async function readCursor(): Promise<string | null> {
  const row = await db.intakeCursor.findUnique({
    where: { source: INTAKE_SOURCE },
    select: { lastEntryId: true },
  });
  return row?.lastEntryId ?? null;
}

async function persistSubmission(submission: BookingSubmission): Promise<boolean> {
  const { customer, stay } = submission;

  // Rejects an impossible stay before it reaches an operator's queue.
  countNights(stay.startDate, stay.endDate);

  try {
    await db.$transaction(async (tx) => {
      const existingCustomer = await tx.customer.findUnique({
        where: { taxId: customer.taxId },
        select: { id: true },
      });

      const customerId = existingCustomer
        ? (
            await tx.customer.update({
              where: { id: existingCustomer.id },
              data: {
                name: customer.name,
                email: customer.email,
                phone: customer.phone,
                addressLine: customer.addressLine,
                city: customer.city,
                province: customer.province,
                postalCode: customer.postalCode,
                country: customer.country,
              },
              select: { id: true },
            })
          ).id
        : (
            await tx.customer.create({
              data: customer,
              select: { id: true },
            })
          ).id;

      await tx.bookingRequest.create({
        data: {
          gravityEntryId: submission.entryId,
          customerId,
          boardType: stay.boardType,
          startDate: stay.startDate,
          endDate: stay.endDate,
          headcount: stay.headcount,
          submittedAt: new Date(`${submission.submittedAt.replace(" ", "T")}Z`),
        },
      });
    });
    return true;
  } catch (error) {
    // The unique entry id is the idempotency key: a re-read is not a failure.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}

export interface RunIntakeOptions {
  client?: GravityFormsClient;
  fieldMap?: GravityFormFieldMap;
}

/**
 * Reads new Gravity Forms entries and turns them into booking requests.
 *
 * The cursor advances entry by entry, and only after that entry is committed,
 * so an interrupted batch resumes exactly where it stopped instead of skipping
 * the remainder.
 */
export async function runIntake(
  options: RunIntakeOptions = {},
): Promise<IntakeSummary> {
  const configured = options.client
    ? null
    : await resolveIntegration("GRAVITY_FORMS");
  const client =
    options.client ??
    createGravityFormsClient({
      apiUrl: configured!.config.apiUrl,
      formId: configured!.config.formId,
      consumerKey: configured!.config.consumerKey,
      consumerSecret: configured!.secret,
    });
  const parser = createBookingSubmissionParser(
    options.fieldMap ?? configured?.config.fieldMap ?? DEFAULT_GRAVITY_FORM_FIELDS,
  );

  const startingCursor = await readCursor();
  const entries = await client.fetchEntriesAfter(startingCursor);

  const summary: IntakeSummary = {
    read: entries.length,
    created: 0,
    skipped: 0,
    rejected: 0,
    cursor: startingCursor,
  };

  for (const entry of entries) {
    const parsed = parser.parse(entry);

    if (!parsed.ok) {
      summary.rejected += 1;
      logger.warn(
        {
          event: "booking_intake_entry_rejected",
          entryId: parsed.entryId,
          issues: parsed.issues,
        },
        "booking intake rejected a malformed entry",
      );
    } else if (await persistSubmission(parsed.submission)) {
      summary.created += 1;
    } else {
      summary.skipped += 1;
    }

    await db.intakeCursor.upsert({
      where: { source: INTAKE_SOURCE },
      create: { source: INTAKE_SOURCE, lastEntryId: entry.id },
      update: { lastEntryId: entry.id },
    });
    summary.cursor = entry.id;
  }

  logger.info(
    { event: "booking_intake_batch", ...summary },
    "booking intake batch completed",
  );

  return summary;
}
