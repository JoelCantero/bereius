import "server-only";

import { db } from "@/lib/db";
import {
  createHoldedClient,
  type HoldedClient,
  type HoldedDocumentLine,
} from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import { enqueueJob, type OutboxJob } from "@/modules/booking/services/outbox";
import { paymentDeadlineFrom } from "@/modules/booking/services/expiry";
import {
  quoteStay,
  resolveHeadcountBand,
  SECURITY_DEPOSIT_CENTS,
  VAT_PERCENT,
} from "@/modules/booking/services/pricing";
import {
  normalizeTaxId,
  resolveIntegration,
  type HoldedConfig,
} from "@/modules/booking/services/settings";
import {
  ADVANCE_LINE,
  DEPOSIT_LINE,
  quoteNotes,
  stayDescription,
  stayPhrase as quoteStayPhrase,
} from "@/modules/booking/wording";

/** Holded identifies a rate by key, confirmed against the account's tax list. */
const VAT_TAX_KEY = `s_iva_${VAT_PERCENT}`;
const ZERO_TAX_KEY = "s_iva_0";

export const QUOTE_JOB_KIND = "booking.quote";

export function quoteJobKey(bookingRequestId: string): string {
  return `${QUOTE_JOB_KIND}:${bookingRequestId}`;
}

export async function enqueueQuote(bookingRequestId: string): Promise<boolean> {
  return enqueueJob({
    kind: QUOTE_JOB_KIND,
    idempotencyKey: quoteJobKey(bookingRequestId),
    payload: { bookingRequestId },
  });
}

export class QuotingError extends Error {
  constructor(
    readonly code:
      | "unknown_booking"
      | "wrong_state"
      | "no_service"
      | "incomplete_configuration",
    message: string,
  ) {
    super(message);
    this.name = "QuotingError";
  }
}

function centsToAmount(cents: number): number {
  return cents / 100;
}

/**
 * Turns an approved booking into a Holded contact, estimate and reserve
 * invoice.
 *
 * Every step is guarded by persisted state, so a retry after a partial failure
 * resumes instead of duplicating. The retired workflow chained four dependent
 * calls with no compensation: a failure at the last step left an invoice issued
 * against an estimate that still showed the full amount, and nobody was told.
 */
export async function runQuoteJob(
  job: OutboxJob,
  overrides: { client?: HoldedClient; config?: HoldedConfig } = {},
): Promise<void> {
  const payload = job.payload as { bookingRequestId?: unknown };
  const bookingRequestId = String(payload.bookingRequestId ?? "");

  const booking = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    include: { customer: true, documents: true },
  });

  if (!booking) {
    throw new QuotingError("unknown_booking", "Booking request not found");
  }
  if (booking.state !== "APPROVED" && booking.state !== "AWAITING_PAYMENT") {
    throw new QuotingError(
      "wrong_state",
      `Booking is in ${booking.state}; quoting expects APPROVED`,
    );
  }

  const resolved = overrides.config
    ? { config: overrides.config, secret: "" }
    : await resolveIntegration("HOLDED");
  const config = resolved.config;
  const client = overrides.client ?? createHoldedClient(resolved.secret);

  // The settings screen allows saving the API key before the identifiers are
  // chosen, so completeness is enforced here rather than blocking that step.
  if (!config.salesChannelId) {
    throw new QuotingError(
      "incomplete_configuration",
      "Holded settings are missing the sales channel",
    );
  }
  const salesChannelId = config.salesChannelId;

  // Step 1 — contact. Skipped once the Holded identifier is known.
  let holdedContactId = booking.customer.holdedContactId;
  if (!holdedContactId) {
    const details = {
      name: booking.customer.name,
      code: booking.customer.taxId,
      email: booking.customer.email,
      phone: booking.customer.phone,
      address: booking.customer.addressLine,
      city: booking.customer.city,
      province: booking.customer.province,
      postalCode: booking.customer.postalCode,
      country: booking.customer.country,
    };
    const existing = await client.findContactByTaxId(booking.customer.taxId);

    if (existing) {
      holdedContactId = existing.id;
      if (existing.email?.toLowerCase() !== booking.customer.email.toLowerCase()) {
        await client.updateContact(existing.id, details);
      }
    } else {
      holdedContactId = (await client.createContact(details)).id;
    }

    await db.customer.update({
      where: { id: booking.customerId },
      data: { holdedContactId },
    });
  }

  // Step 2 — price. Read from Holded so a rate change needs no deploy.
  // A negotiated customer is billed against one service whatever the group size:
  // the per-customer override wins, then the tax identifiers on the settings.
  const negotiatedByList = config.negotiatedTaxIds
    .map(normalizeTaxId)
    .includes(normalizeTaxId(booking.customer.taxId))
    ? config.negotiatedServiceId
    : undefined;

  const serviceId =
    booking.customer.negotiatedServiceId ??
    negotiatedByList ??
    config.serviceIdsBySku[
      `${booking.boardType === "FULL_BOARD" ? "pc" : "dc"}${resolveHeadcountBand(
        booking.headcount,
      )}`
    ];

  if (!serviceId) {
    throw new QuotingError(
      "no_service",
      "No Holded service is configured for this board type and headcount",
    );
  }

  const quote = quoteStay({
    boardType: booking.boardType,
    headcount: booking.headcount,
    startDate: booking.startDate,
    endDate: booking.endDate,
    unitPriceCents: await client.getServicePriceCents(serviceId),
  });

  const description = stayDescription(
    booking.startDate,
    booking.endDate,
    quote.billableHeadcount,
    booking.boardType === "FULL_BOARD" ? "PC" : "DC",
  );
  const stayPhrase = quoteStayPhrase(
    booking.startDate,
    booking.endDate,
    quote.billableHeadcount,
    quote.nights,
  );
  const notes = quoteNotes({
    startDate: booking.startDate,
    endDate: booking.endDate,
    headcount: quote.billableHeadcount,
    nights: quote.nights,
    advanceCents: quote.advanceCents,
    depositCents: quote.depositCents,
    amountToConfirmCents: quote.amountToConfirmCents,
  });

  const stayLine: HoldedDocumentLine = {
    serviceId,
    salesChannelId,
    units: quote.units,
    price: centsToAmount(quote.unitPriceCents),
    taxes: [VAT_TAX_KEY],
    description: stayPhrase,
  };

  // Step 3 — estimate.
  const existingEstimate = booking.documents.find((doc) => doc.type === "ESTIMATE");
  let estimateId = existingEstimate?.holdedId ?? null;

  if (!estimateId) {
    const estimate = await client.createEstimate({
      contactId: holdedContactId,
      description,
      notes,
      language: config.language,
      paymentMethodId: config.paymentMethodId,
      items: [stayLine],
    });
    estimateId = estimate.id;

    await db.holdedDocument.create({
      data: {
        bookingRequestId: booking.id,
        type: "ESTIMATE",
        holdedId: estimate.id,
        documentNumber: estimate.number,
        totalCents: quote.stayTotalCents,
      },
    });

    await client.sendEstimate(
      estimate.id,
      [booking.customer.email],
      config.mailTemplateId,
    );
  }

  // Step 4 — reserve invoice for the advance and the deposit.
  const paymentDueAt = booking.paymentDueAt ?? paymentDeadlineFrom(new Date());

  if (!booking.documents.some((doc) => doc.type === "RESERVE_INVOICE")) {
    // v2 offers no way to reference the source estimate when the lines differ
    // from it, so the link between the two lives in our own tables.
    const invoice = await client.createInvoice({
      contactId: holdedContactId,
      description,
      notes,
      language: config.language,
      paymentMethodId: config.paymentMethodId,
      dueDate: paymentDueAt,
      // The advance alone: the deposit is money held and returned, not income,
      // so it is asked for but never invoiced.
      items: [
        {
          name: ADVANCE_LINE.name,
          units: 1,
          price: centsToAmount(quote.advanceNetCents),
          taxes: [VAT_TAX_KEY],
          salesChannelId,
          description: ADVANCE_LINE.description,
        },
      ],
    });

    await db.holdedDocument.create({
      data: {
        bookingRequestId: booking.id,
        type: "RESERVE_INVOICE",
        holdedId: invoice.id,
        documentNumber: invoice.number,
        totalCents: quote.advanceCents,
      },
    });
  }

  // Step 5 — deduct what was invoiced, so the estimate shows the balance owed.
  await client.replaceEstimateLines(estimateId, [
    stayLine,
    {
      name: DEPOSIT_LINE.name,
      units: 1,
      price: -centsToAmount(SECURITY_DEPOSIT_CENTS),
      taxes: [ZERO_TAX_KEY],
      salesChannelId,
      description: DEPOSIT_LINE.description,
    },
    {
      name: ADVANCE_LINE.name,
      units: 1,
      price: -centsToAmount(quote.advanceNetCents),
      taxes: [VAT_TAX_KEY],
      salesChannelId,
      description: ADVANCE_LINE.description,
    },
  ]);

  await db.bookingRequest.update({
    where: { id: booking.id },
    data: {
      billableUnits: quote.units,
      unitPriceCents: quote.unitPriceCents,
      advanceCents: quote.advanceCents,
      depositCents: quote.depositCents,
      paymentDueAt,
    },
  });

  logger.info(
    {
      event: "booking_quote_issued",
      bookingRequestId: booking.id,
      units: quote.units,
      advanceCents: quote.advanceCents,
    },
    "booking quote issued in Holded",
  );
}
