import "server-only";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  HoldedDeliveryError,
  type HoldedClient,
  type HoldedEstimateRecipients,
} from "@/lib/holded/client";
import { logger } from "@/lib/logger";

const recipientSchema = z.email().max(320);

export class EstimateDeliveryError extends Error {
  constructor(
    readonly code:
      | "missing_fiscal_email"
      | "invalid_delegate_email"
      | "unlinked_customer"
      | "unknown_estimate"
      | "invalid_delivery",
    message: string,
  ) {
    super(message);
    this.name = "EstimateDeliveryError";
  }
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return recipientSchema.safeParse(normalized).success ? normalized : null;
}

export function resolveEstimateRecipients(
  fiscalEmail: string,
  delegateEmails: readonly string[],
): HoldedEstimateRecipients {
  const primary = normalizeEmail(fiscalEmail);
  if (!primary) {
    throw new EstimateDeliveryError(
      "missing_fiscal_email",
      "The customer has no usable fiscal email",
    );
  }

  const copies = new Set<string>();
  for (const delegateEmail of delegateEmails) {
    const email = normalizeEmail(delegateEmail);
    if (!email) {
      throw new EstimateDeliveryError(
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

export async function prepareEstimateDelivery(
  holdedDocumentId: string,
  client: Pick<HoldedClient, "listDelegateEmails">,
) {
  const document = await db.holdedDocument.findUnique({
    where: { id: holdedDocumentId },
    include: {
      estimateDelivery: true,
      bookingRequest: { include: { customer: true } },
    },
  });
  if (!document || document.type !== "ESTIMATE") {
    throw new EstimateDeliveryError(
      "unknown_estimate",
      "Estimate document does not exist",
    );
  }
  if (document.sentAt) return null;
  if (document.estimateDelivery) return document.estimateDelivery;
  const principalHoldedContactId = document.bookingRequest.customer.holdedContactId;
  if (!principalHoldedContactId) {
    throw new EstimateDeliveryError(
      "unlinked_customer",
      "The customer has no Holded contact",
    );
  }

  const delegateEmails = await client.listDelegateEmails(principalHoldedContactId);
  const recipients = resolveEstimateRecipients(
    document.bookingRequest.customer.email,
    delegateEmails,
  );

  const delivery = await db.$transaction(async (tx) => {
    const fresh = await tx.holdedDocument.findUnique({
      where: { id: holdedDocumentId },
      include: {
        estimateDelivery: true,
        bookingRequest: { include: { customer: true } },
      },
    });
    if (!fresh || fresh.type !== "ESTIMATE") {
      throw new EstimateDeliveryError(
        "unknown_estimate",
        "Estimate document does not exist",
      );
    }
    if (fresh.sentAt) return null;
    if (fresh.estimateDelivery) return fresh.estimateDelivery;

    return tx.estimateDelivery.upsert({
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
      event: "booking_estimate_delivery_prepared",
      holdedDocumentId,
      ccCount:
        delivery && Array.isArray(delivery.ccEmails)
          ? delivery.ccEmails.length
          : 0,
    },
    "estimate delivery recipients prepared",
  );
  return delivery;
}

function readCcEmails(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EstimateDeliveryError(
      "invalid_delivery",
      "Stored estimate recipients are invalid",
    );
  }
  return value;
}

export async function deliverPreparedEstimate(
  holdedDocumentId: string,
  client: Pick<HoldedClient, "sendEstimate">,
  mailTemplateId?: string,
): Promise<"accepted" | "unknown"> {
  const document = await db.holdedDocument.findUnique({
    where: { id: holdedDocumentId },
    include: { estimateDelivery: true },
  });
  if (!document || document.type !== "ESTIMATE") {
    throw new EstimateDeliveryError(
      "unknown_estimate",
      "Estimate document does not exist",
    );
  }
  if (document.sentAt || document.estimateDelivery?.status === "ACCEPTED") {
    return "accepted";
  }

  const delivery = document.estimateDelivery;
  if (!delivery) {
    throw new EstimateDeliveryError(
      "invalid_delivery",
      "Estimate recipients have not been prepared",
    );
  }
  if (delivery.status === "UNKNOWN") return "unknown";
  if (delivery.status === "IN_FLIGHT") {
    await db.estimateDelivery.updateMany({
      where: { id: delivery.id, status: "IN_FLIGHT" },
      data: { status: "UNKNOWN", outcomeUnknownAt: new Date() },
    });
    logger.warn(
      { event: "booking_estimate_delivery_unknown", holdedDocumentId },
      "interrupted estimate delivery parked",
    );
    return "unknown";
  }

  const claimed = await db.estimateDelivery.updateMany({
    where: { id: delivery.id, status: delivery.status },
    data: {
      status: "IN_FLIGHT",
      attemptedAt: new Date(),
      lastFailureCode: null,
      outcomeUnknownAt: null,
    },
  });
  if (claimed.count !== 1) {
    return deliverPreparedEstimate(holdedDocumentId, client, mailTemplateId);
  }

  try {
    await client.sendEstimate(
      document.holdedId,
      {
        emails: [delivery.toEmail],
        cc: readCcEmails(delivery.ccEmails),
      },
      mailTemplateId,
    );
  } catch (error) {
    const definitive =
      error instanceof HoldedDeliveryError &&
      error.deliveryOutcome === "definitive_failure";
    const status = definitive ? "FAILED" : "UNKNOWN";
    const failureCode =
      error instanceof HoldedDeliveryError ? error.code : "unexpected";

    await db.estimateDelivery.updateMany({
      where: { id: delivery.id, status: "IN_FLIGHT" },
      data: {
        status,
        lastFailureCode: failureCode,
        outcomeUnknownAt: definitive ? null : new Date(),
      },
    });
    logger.warn(
      {
        event: "booking_estimate_delivery_failed",
        holdedDocumentId,
        status,
        code: failureCode,
      },
      "estimate delivery failed",
    );
    throw error;
  }

  const acceptedAt = new Date();
  await db.$transaction([
    db.estimateDelivery.update({
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
    { event: "booking_estimate_delivery_accepted", holdedDocumentId },
    "estimate delivery accepted",
  );
  return "accepted";
}