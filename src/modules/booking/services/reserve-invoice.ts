import "server-only";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  createHoldedClient,
  HoldedCreationError,
  HoldedError,
  type HoldedClient,
  type HoldedInvoiceLineSummary,
  type HoldedInvoiceSummary,
} from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import {
  deliverPreparedDocument,
  prepareDocumentDelivery,
} from "@/modules/booking/services/document-delivery";
import { enqueueJob } from "@/modules/booking/services/outbox";
import type { OutboxJob } from "@/modules/booking/services/outbox";
import type { BookingTransactionClient } from "@/modules/booking/services/lifecycle";
import {
  billableHeadcount,
  countNights,
  VAT_PERCENT,
} from "@/modules/booking/services/pricing";
import {
  resolveIntegration,
  type HoldedConfig,
} from "@/modules/booking/services/settings";
import {
  ADVANCE_LINE,
  bookingManagementSubject,
  DEPOSIT_LINE,
  quoteNotes,
  stayDescription,
} from "@/modules/booking/wording";

export const RESERVE_INVOICE_JOB_KIND = "booking.reserve-invoice";
const VAT_TAX_KEY = `s_iva_${VAT_PERCENT}`;
const UNTAXED_KEY = "s_iva_nosujeto";

const reserveInvoicePayloadSchema = z
  .object({
    bookingRequestId: z.string().min(1).max(191),
    paymentId: z.string().min(1).max(191),
  })
  .strict();

export type ReserveInvoiceClient = Pick<
  HoldedClient,
  | "readService"
  | "listNumberingSeries"
  | "createInvoice"
  | "getInvoice"
  | "approveInvoice"
  | "listDelegateEmails"
  | "sendEstimate"
  | "sendInvoice"
>;

export class ReserveInvoiceError extends Error {
  constructor(
    readonly code:
      | "invalid_job"
      | "unknown_booking"
      | "invalid_payment"
      | "incomplete_configuration",
    message: string,
  ) {
    super(message);
    this.name = "ReserveInvoiceError";
  }
}

export function reserveInvoiceJobKey(bookingRequestId: string): string {
  return `${RESERVE_INVOICE_JOB_KIND}:${bookingRequestId}`;
}

export async function enqueueReserveInvoice(
  command: { bookingRequestId: string; paymentId: string },
  transaction: BookingTransactionClient,
): Promise<void> {
  await transaction.documentIssuance.upsert({
    where: {
      bookingRequestId_type: {
        bookingRequestId: command.bookingRequestId,
        type: "RESERVE_INVOICE",
      },
    },
    update: {},
    create: {
      bookingRequestId: command.bookingRequestId,
      type: "RESERVE_INVOICE",
    },
  });

  await enqueueJob(
    {
      kind: RESERVE_INVOICE_JOB_KIND,
      idempotencyKey: reserveInvoiceJobKey(command.bookingRequestId),
      payload: command,
    },
    transaction,
  );
}

interface ExpectedInvoice {
  contactId: string;
  date: string;
  dueDate: string;
  totalCents: number;
  advance: {
    serviceId: string;
    accountId: string;
    amountCents: number;
  };
  deposit: {
    serviceId: string;
    accountId: string;
    amountCents: number;
  };
}

function hasExactTax(line: HoldedInvoiceLineSummary, tax: string): boolean {
  if (tax === UNTAXED_KEY && line.taxes.length === 0) return true;
  return line.taxes.length === 1 && line.taxes[0] === tax;
}

function lineAmountCents(
  line: HoldedInvoiceLineSummary,
  tax: string,
  taxIncluded: boolean,
): number {
  if (taxIncluded || tax === UNTAXED_KEY) return line.priceCents;
  return Math.round((line.priceCents * (100 + VAT_PERCENT)) / 100);
}

function matchingLine(
  lines: readonly HoldedInvoiceLineSummary[],
  expected: ExpectedInvoice["advance"] | ExpectedInvoice["deposit"],
  tax: string,
  taxIncluded: boolean,
): boolean {
  return lines.some(
    (line) =>
      (line.serviceId === null || line.serviceId === expected.serviceId) &&
      line.accountId === expected.accountId &&
      line.units === 1 &&
      lineAmountCents(line, tax, taxIncluded) === expected.amountCents &&
      hasExactTax(line, tax),
  );
}

export function isCompatibleReserveInvoice(
  invoice: HoldedInvoiceSummary,
  expected: ExpectedInvoice,
): boolean {
  return (
    invoice.contactId === expected.contactId &&
    invoice.date === expected.date &&
    invoice.dueDate === expected.dueDate &&
    invoice.totalCents === expected.totalCents &&
    invoice.items.length === 2 &&
    matchingLine(invoice.items, expected.advance, VAT_TAX_KEY, invoice.taxIncluded) &&
    matchingLine(invoice.items, expected.deposit, UNTAXED_KEY, invoice.taxIncluded)
  );
}

async function markBlocked(issuanceId: string, failureCode: string) {
  await db.documentIssuance.update({
    where: { id: issuanceId },
    data: {
      status: "BLOCKED",
      blockedAt: new Date(),
      lastFailureCode: failureCode,
    },
  });
}

async function deliverInvoice(
  holdedDocumentId: string,
  client: ReserveInvoiceClient,
  subject: string,
): Promise<void> {
  const delivery = await prepareDocumentDelivery(holdedDocumentId, client);
  if (delivery) {
    await deliverPreparedDocument(holdedDocumentId, client, undefined, subject);
  }
}

function invoiceIsApproved(status: string | null): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "approved" || normalized === "completed";
}

async function issueKnownInvoice(command: {
  issuanceId: string;
  holdedDocumentId: string;
  client: ReserveInvoiceClient;
  subject: string;
  invoice?: HoldedInvoiceSummary;
}): Promise<void> {
  if (!command.invoice || !invoiceIsApproved(command.invoice.status)) {
    try {
      const document = await db.holdedDocument.findUniqueOrThrow({
        where: { id: command.holdedDocumentId },
        select: { holdedId: true },
      });
      await command.client.approveInvoice(document.holdedId);
    } catch (error) {
      await db.documentIssuance.update({
        where: { id: command.issuanceId },
        data: {
          status: "FAILED",
          lastFailureCode: error instanceof HoldedError ? error.code : "unexpected",
        },
      });
      throw error;
    }
  }

  const issuedAt = new Date();
  await db.documentIssuance.update({
    where: { id: command.issuanceId },
    data: {
      status: "ISSUED",
      holdedDocumentId: command.holdedDocumentId,
      issuedAt,
      blockedAt: null,
      outcomeUnknownAt: null,
      lastFailureCode: null,
    },
  });
  await deliverInvoice(command.holdedDocumentId, command.client, command.subject);
}

export async function runReserveInvoiceJob(
  job: OutboxJob,
  overrides: { client?: ReserveInvoiceClient; config?: HoldedConfig } = {},
): Promise<void> {
  const payload = reserveInvoicePayloadSchema.safeParse(job.payload);
  if (!payload.success) {
    throw new ReserveInvoiceError("invalid_job", "Invalid reserve invoice job");
  }

  const issuance = await db.documentIssuance.findUnique({
    where: {
      bookingRequestId_type: {
        bookingRequestId: payload.data.bookingRequestId,
        type: "RESERVE_INVOICE",
      },
    },
    include: {
      holdedDocument: true,
      bookingRequest: {
        include: {
          customer: true,
          documents: { where: { type: "RESERVE_INVOICE" }, take: 1 },
        },
      },
    },
  });
  if (!issuance) {
    throw new ReserveInvoiceError("unknown_booking", "Invoice issuance not found");
  }
  const payment = await db.payment.findUnique({
    where: { id: payload.data.paymentId },
  });
  if (
    !payment ||
    payment.bookingRequestId !== issuance.bookingRequestId ||
    payment.bankMovementId === null
  ) {
    throw new ReserveInvoiceError(
      "invalid_payment",
      "Reserve invoice requires its bank-linked payment",
    );
  }
  if (issuance.status === "BLOCKED" || issuance.status === "UNKNOWN") return;

  const resolved = overrides.config
    ? { config: overrides.config, secret: "" }
    : await resolveIntegration("HOLDED");
  const config = resolved.config;
  const client = overrides.client ?? createHoldedClient(resolved.secret);
  const subject = bookingManagementSubject(config.language);
  const booking = issuance.bookingRequest;
  const existingDocument =
    issuance.holdedDocument ?? booking.documents[0] ?? null;

  if (issuance.status === "ISSUED") {
    if (!existingDocument) {
      await markBlocked(issuance.id, "issued_document_missing");
      return;
    }
    await deliverInvoice(existingDocument.id, client, subject);
    return;
  }
  if (issuance.status === "IN_FLIGHT" && !existingDocument) {
    await db.documentIssuance.update({
      where: { id: issuance.id },
      data: {
        status: "UNKNOWN",
        outcomeUnknownAt: new Date(),
        lastFailureCode: "interrupted_creation",
      },
    });
    return;
  }

  if (!config.advanceServiceId || !config.depositServiceId) {
    throw new ReserveInvoiceError(
      "incomplete_configuration",
      "Holded settings are missing the advance or deposit service",
    );
  }
  if (
    !booking.customer.holdedContactId ||
    booking.advanceCents === null ||
    booking.depositCents === null
  ) {
    throw new ReserveInvoiceError(
      "unknown_booking",
      "Booking has no invoiceable contact or agreed amounts",
    );
  }

  const [advanceService, depositService] = await Promise.all([
    client.readService(config.advanceServiceId),
    client.readService(config.depositServiceId),
  ]);
  if (!advanceService.accountId || !depositService.accountId) {
    throw new ReserveInvoiceError(
      "incomplete_configuration",
      "A configured Holded service has no accounting account",
    );
  }

  const expected: ExpectedInvoice = {
    contactId: booking.customer.holdedContactId,
    date: payment.createdAt.toISOString().slice(0, 10),
    dueDate: payment.createdAt.toISOString().slice(0, 10),
    totalCents: booking.advanceCents + booking.depositCents,
    advance: {
      serviceId: config.advanceServiceId,
      accountId: advanceService.accountId,
      amountCents: booking.advanceCents,
    },
    deposit: {
      serviceId: config.depositServiceId,
      accountId: depositService.accountId,
      amountCents: booking.depositCents,
    },
  };

  if (existingDocument) {
    const invoice = await client.getInvoice(existingDocument.holdedId);
    if (!invoice) {
      await markBlocked(issuance.id, "existing_invoice_missing");
      return;
    }
    if (!isCompatibleReserveInvoice(invoice, expected)) {
      await markBlocked(issuance.id, "incompatible_existing_invoice");
      return;
    }
    await issueKnownInvoice({
      issuanceId: issuance.id,
      holdedDocumentId: existingDocument.id,
      client,
      subject,
      invoice,
    });
    return;
  }

  const series = await client.listNumberingSeries("invoice");
  const numberingSeriesId = series.find(
    (option) => option.name.trim().toUpperCase() === "F",
  )?.id;
  if (!numberingSeriesId) {
    await db.documentIssuance.update({
      where: { id: issuance.id },
      data: { status: "FAILED", lastFailureCode: "missing_invoice_series" },
    });
    throw new ReserveInvoiceError(
      "incomplete_configuration",
      "Holded has no F numbering series for invoices",
    );
  }

  const claimed = await db.documentIssuance.updateMany({
    where: {
      id: issuance.id,
      status: { in: ["PREPARED", "FAILED"] },
    },
    data: {
      status: "IN_FLIGHT",
      attemptedAt: new Date(),
      blockedAt: null,
      outcomeUnknownAt: null,
      lastFailureCode: null,
    },
  });
  if (claimed.count !== 1) return;

  const nights = countNights(booking.startDate, booking.endDate);
  const billedHeadcount = billableHeadcount(booking.headcount);
  const description = stayDescription(
    booking.startDate,
    booking.endDate,
    billedHeadcount,
    booking.boardType === "FULL_BOARD" ? "PC" : "DC",
  );
  const notes = quoteNotes({
    startDate: booking.startDate,
    endDate: booking.endDate,
    headcount: billedHeadcount,
    nights,
    advanceCents: booking.advanceCents,
    depositCents: booking.depositCents,
    amountToConfirmCents: expected.totalCents,
  });

  let created;
  try {
    created = await client.createInvoice({
      contactId: expected.contactId,
      description,
      notes,
      language: config.language,
      paymentMethodId: config.paymentMethodId,
      numberingSeriesId,
      date: payment.createdAt,
      dueDate: payment.createdAt,
      items: [
        {
          name: ADVANCE_LINE.name,
          description: ADVANCE_LINE.description,
          serviceId: expected.advance.serviceId,
          accountId: expected.advance.accountId,
          units: 1,
          price: expected.advance.amountCents / 100,
          taxes: [VAT_TAX_KEY],
        },
        {
          name: DEPOSIT_LINE.name,
          description: DEPOSIT_LINE.description,
          serviceId: expected.deposit.serviceId,
          accountId: expected.deposit.accountId,
          units: 1,
          price: expected.deposit.amountCents / 100,
          taxes: [UNTAXED_KEY],
        },
      ],
    });
  } catch (error) {
    const definitive =
      error instanceof HoldedCreationError &&
      error.creationOutcome === "definitive_failure";
    const status = definitive ? "FAILED" : "UNKNOWN";
    await db.documentIssuance.update({
      where: { id: issuance.id },
      data: {
        status,
        outcomeUnknownAt: definitive ? null : new Date(),
        lastFailureCode: error instanceof HoldedError ? error.code : "unexpected",
      },
    });
    if (definitive) throw error;
    logger.warn(
      {
        event: "booking_reserve_invoice_creation_unknown",
        bookingRequestId: booking.id,
      },
      "reserve invoice creation outcome is unknown",
    );
    return;
  }

  let document;
  try {
    document = await db.$transaction(async (transaction) => {
      const persisted = await transaction.holdedDocument.create({
        data: {
          bookingRequestId: booking.id,
          type: "RESERVE_INVOICE",
          holdedId: created.id,
          documentNumber: created.number,
          totalCents: expected.totalCents,
        },
      });
      await transaction.documentIssuance.update({
        where: { id: issuance.id },
        data: { holdedDocumentId: persisted.id },
      });
      return persisted;
    });
  } catch (error) {
    await db.documentIssuance.updateMany({
      where: { id: issuance.id, status: "IN_FLIGHT" },
      data: {
        status: "UNKNOWN",
        outcomeUnknownAt: new Date(),
        lastFailureCode: "persistence_after_create",
      },
    });
    throw error;
  }

  await issueKnownInvoice({
    issuanceId: issuance.id,
    holdedDocumentId: document.id,
    client,
    subject,
  });
  logger.info(
    {
      event: "booking_reserve_invoice_issued",
      bookingRequestId: booking.id,
    },
    "reserve invoice issued and delivery attempted",
  );
}