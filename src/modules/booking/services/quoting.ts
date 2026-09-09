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
  resolveIntegration,
  type HoldedConfig,
} from "@/modules/booking/services/settings";

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
    readonly code: "unknown_booking" | "wrong_state" | "no_service",
    message: string,
  ) {
    super(message);
    this.name = "QuotingError";
  }
}

function centsToAmount(cents: number): number {
  return cents / 100;
}

function stayDescription(
  startDate: Date,
  endDate: Date,
  headcount: number,
  boardType: string,
): string {
  const format = (date: Date) => date.toISOString().slice(0, 10);
  return `${format(startDate)} - ${format(endDate)} - ${headcount} places ${boardType}`;
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

  // Step 1 — contact. Skipped once the Holded identifier is known.
  let holdedContactId = booking.customer.holdedContactId;
  if (!holdedContactId) {
    const existing = await client.findContactByTaxId(booking.customer.taxId);

    if (existing) {
      holdedContactId = existing.id;
      if (existing.email?.toLowerCase() !== booking.customer.email.toLowerCase()) {
        await client.updateContactEmail(existing.id, booking.customer.email);
      }
    } else {
      holdedContactId = (
        await client.createContact({
          name: booking.customer.name,
          code: booking.customer.taxId,
          email: booking.customer.email,
          phone: booking.customer.phone,
          address: booking.customer.addressLine,
          city: booking.customer.city,
          province: booking.customer.province,
          postalCode: booking.customer.postalCode,
          country: booking.customer.country,
        })
      ).id;
    }

    await db.customer.update({
      where: { id: booking.customerId },
      data: { holdedContactId },
    });
  }

  // Step 2 — price. Read from Holded so a rate change needs no deploy.
  const serviceId =
    booking.customer.negotiatedServiceId ??
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
  const notes = `${quote.nights} nights. Advance ${centsToAmount(
    quote.advanceCents,
  )} EUR, deposit ${centsToAmount(quote.depositCents)} EUR, total to confirm ${centsToAmount(
    quote.amountToConfirmCents,
  )} EUR.`;

  const stayLine: HoldedDocumentLine = {
    serviceId,
    accountingAccountId: config.accountingAccountId,
    units: quote.units,
    desc: description,
  };

  // Step 3 — estimate.
  const existingEstimate = booking.documents.find((doc) => doc.type === "ESTIMATE");
  let estimateId = existingEstimate?.holdedId ?? null;

  if (!estimateId) {
    const estimate = await client.createEstimate({
      contactCode: booking.customer.taxId,
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
    const invoice = await client.createInvoiceFromEstimate({
      contactCode: booking.customer.taxId,
      description,
      notes,
      language: config.language,
      paymentMethodId: config.paymentMethodId,
      fromEstimateId: estimateId,
      dueDate: paymentDueAt,
      items: [
        {
          serviceId: config.depositServiceId,
          units: 1,
          desc: "Refundable security deposit",
          subtotal: centsToAmount(SECURITY_DEPOSIT_CENTS),
        },
        {
          name: "Advance",
          units: 1,
          desc: "30% of the stay total",
          tax: VAT_PERCENT,
          taxes: `s_iva_${VAT_PERCENT}`,
          accountingAccountId: config.accountingAccountId,
          subtotal: centsToAmount(quote.advanceNetCents),
        },
      ],
    });

    await db.holdedDocument.create({
      data: {
        bookingRequestId: booking.id,
        type: "RESERVE_INVOICE",
        holdedId: invoice.id,
        documentNumber: invoice.number,
        totalCents: quote.amountToConfirmCents,
      },
    });
  }

  // Step 5 — deduct what was invoiced, so the estimate shows the balance owed.
  await client.replaceEstimateLines(estimateId, [
    stayLine,
    {
      name: "Security deposit",
      units: 1,
      desc: "Returned after the stay",
      accountingAccountId: config.accountingAccountId,
      subtotal: -centsToAmount(SECURITY_DEPOSIT_CENTS),
    },
    {
      name: "Advance",
      units: 1,
      desc: "30% of the stay total",
      tax: VAT_PERCENT,
      taxes: `s_iva_${VAT_PERCENT}`,
      accountingAccountId: config.accountingAccountId,
      subtotal: -centsToAmount(quote.advanceNetCents),
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
