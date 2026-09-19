import "server-only";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  HoldedDeliveryError,
  type HoldedClient,
  type HoldedDocumentRecipients,
} from "@/lib/holded/client";
import { logger } from "@/lib/logger";

const recipientSchema = z.email().max(320);

export class DocumentDeliveryError extends Error {
  constructor(
    readonly code:
      | "missing_fiscal_email"
      | "invalid_delegate_email"
      | "unlinked_customer"
      | "unknown_document"
      | "invalid_delivery",
    message: string,
  ) {
    super(message);
    this.name = "DocumentDeliveryError";
  }
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return recipientSchema.safeParse(normalized).success ? normalized : null;
}

export function resolveDocumentRecipients(
  fiscalEmail: string,
  delegateEmails: readonly string[],
): HoldedDocumentRecipients {
  const primary = normalizeEmail(fiscalEmail);
  if (!primary) {
    throw new DocumentDeliveryError(
      "missing_fiscal_email",
      "The customer has no usable fiscal email",
    );
  }

  const copies = new Set<string>();
  for (const delegateEmail of delegateEmails) {
    const email = normalizeEmail(delegateEmail);
    if (!email) {
      throw new DocumentDeliveryError(
        "invalid_delegate_email",
        "An active representative has no usable email",
      );
    }
    if (email !== primary) copies.add(email);
  }

  return {
    emails: [primary],
    cc: [...copies].sort(),
  };
}

function supportsDelivery(type: string): type is "ESTIMATE" | "RESERVE_INVOICE" {
  return type === "ESTIMATE" || type === "RESERVE_INVOICE";
}

export async function prepareDocumentDelivery(
  holdedDocumentId: string,
  client: Pick<HoldedClient, "listDelegateEmails">,
) {
  const document = await db.holdedDocument.findUnique({
    where: { id: holdedDocumentId },
    include: {
      delivery: true,
      bookingRequest: { include: { customer: true } },
    },
  });
  if (!document || !supportsDelivery(document.type)) {
    throw new DocumentDeliveryError(
      "unknown_document",
      "Deliverable Holded document does not exist",
    );
  }
  if (document.sentAt) return null;
  if (document.delivery) return document.delivery;
  const principalHoldedContactId = document.bookingRequest.customer.holdedContactId;
  if (!principalHoldedContactId) {
    throw new DocumentDeliveryError(
      "unlinked_customer",
      "The customer has no Holded contact",
    );
  }

  const delegateEmails = await client.listDelegateEmails(principalHoldedContactId);
  const recipients = resolveDocumentRecipients(
    document.bookingRequest.customer.email,
    delegateEmails,
  );

  const delivery = await db.$transaction(async (transaction) => {
    const fresh = await transaction.holdedDocument.findUnique({
      where: { id: holdedDocumentId },
      include: { delivery: true },
    });
    if (!fresh || !supportsDelivery(fresh.type)) {
      throw new DocumentDeliveryError(
        "unknown_document",
        "Deliverable Holded document does not exist",
      );
    }
    if (fresh.sentAt) return null;
    if (fresh.delivery) return fresh.delivery;

    return transaction.documentDelivery.upsert({
      where: { holdedDocumentId },
      update: {},
      create: {
        holdedDocumentId,
        toEmail: recipients.emails[0]!,
        ccEmails: recipients.cc,
      },
    });
  });

  logger.info(
    {
      event: "booking_document_delivery_prepared",
      holdedDocumentId,
      documentType: document.type,
      ccCount:
        delivery && Array.isArray(delivery.ccEmails)
          ? delivery.ccEmails.length
          : 0,
    },
    "document delivery recipients prepared",
  );
  return delivery;
}

function readCcEmails(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DocumentDeliveryError(
      "invalid_delivery",
      "Stored document recipients are invalid",
    );
  }
  return value;
}

export async function deliverPreparedDocument(
  holdedDocumentId: string,
  client: Pick<HoldedClient, "sendEstimate" | "sendInvoice">,
  mailTemplateId?: string,
  subject?: string,
): Promise<"accepted" | "unknown"> {
  const document = await db.holdedDocument.findUnique({
    where: { id: holdedDocumentId },
    include: { delivery: true },
  });
  if (!document || !supportsDelivery(document.type)) {
    throw new DocumentDeliveryError(
      "unknown_document",
      "Deliverable Holded document does not exist",
    );
  }
  if (document.sentAt || document.delivery?.status === "ACCEPTED") {
    return "accepted";
  }

  const delivery = document.delivery;
  if (!delivery) {
    throw new DocumentDeliveryError(
      "invalid_delivery",
      "Document recipients have not been prepared",
    );
  }
  if (delivery.status === "UNKNOWN") return "unknown";
  if (delivery.status === "IN_FLIGHT") {
    await db.documentDelivery.updateMany({
      where: { id: delivery.id, status: "IN_FLIGHT" },
      data: { status: "UNKNOWN", outcomeUnknownAt: new Date() },
    });
    logger.warn(
      { event: "booking_document_delivery_unknown", holdedDocumentId },
      "interrupted document delivery parked",
    );
    return "unknown";
  }

  const claimed = await db.documentDelivery.updateMany({
    where: { id: delivery.id, status: delivery.status },
    data: {
      status: "IN_FLIGHT",
      attemptedAt: new Date(),
      lastFailureCode: null,
      outcomeUnknownAt: null,
    },
  });
  if (claimed.count !== 1) {
    return deliverPreparedDocument(
      holdedDocumentId,
      client,
      mailTemplateId,
      subject,
    );
  }

  const recipients = {
    emails: [delivery.toEmail],
    cc: readCcEmails(delivery.ccEmails),
  };

  try {
    if (document.type === "ESTIMATE") {
      await client.sendEstimate(
        document.holdedId,
        recipients,
        mailTemplateId,
        subject,
      );
    } else {
      await client.sendInvoice(
        document.holdedId,
        recipients,
        mailTemplateId,
        subject,
      );
    }
  } catch (error) {
    const definitive =
      error instanceof HoldedDeliveryError &&
      error.deliveryOutcome === "definitive_failure";
    const status = definitive ? "FAILED" : "UNKNOWN";
    const failureCode =
      error instanceof HoldedDeliveryError ? error.code : "unexpected";

    await db.documentDelivery.updateMany({
      where: { id: delivery.id, status: "IN_FLIGHT" },
      data: {
        status,
        lastFailureCode: failureCode,
        outcomeUnknownAt: definitive ? null : new Date(),
      },
    });
    logger.warn(
      {
        event: "booking_document_delivery_failed",
        holdedDocumentId,
        documentType: document.type,
        status,
        code: failureCode,
      },
      "document delivery failed",
    );
    throw error;
  }

  const acceptedAt = new Date();
  await db.$transaction([
    db.documentDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "ACCEPTED",
        acceptedAt,
        outcomeUnknownAt: null,
        lastFailureCode: null,
      },
    }),
    db.holdedDocument.update({
      where: { id: holdedDocumentId },
      data: { sentAt: acceptedAt },
    }),
  ]);
  logger.info(
    {
      event: "booking_document_delivery_accepted",
      holdedDocumentId,
      documentType: document.type,
    },
    "document delivery accepted",
  );
  return "accepted";
}