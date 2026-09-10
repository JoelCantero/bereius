import "server-only";

import { db } from "@/lib/db";
import {
  createHoldedClient,
  HoldedError,
  type HoldedClient,
  type HoldedContact,
  type HoldedContactInput,
  type HoldedEstimateSummary,
} from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import { transitionBooking } from "@/modules/booking/services/lifecycle";
import { resolveIntegration } from "@/modules/booking/services/settings";

export const CONTACT_FIELDS = [
  "name",
  "email",
  "phone",
  "addressLine",
  "city",
  "province",
  "postalCode",
  "country",
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

export interface ContactDifference {
  field: ContactField;
  ours: string | null;
  theirs: string | null;
}

export type ContactInspection =
  | { status: "no_key" | "unavailable" }
  | { status: "missing" }
  | {
      status: "matches" | "differs";
      contactId: string;
      differences: ContactDifference[];
      estimates: HoldedEstimateSummary[];
    };

export class ContactSyncError extends Error {
  constructor(readonly code: "unknown_booking" | "not_in_holded") {
    super(code);
    this.name = "ContactSyncError";
  }
}

async function loadCustomer(bookingRequestId: string) {
  const booking = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    select: { customerId: true, customer: true, state: true },
  });

  if (!booking) throw new ContactSyncError("unknown_booking");
  return booking;
}

function toInput(customer: {
  name: string;
  taxId: string;
  email: string;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
}): HoldedContactInput {
  return {
    name: customer.name,
    code: customer.taxId,
    email: customer.email,
    phone: customer.phone,
    address: customer.addressLine,
    city: customer.city,
    province: customer.province,
    postalCode: customer.postalCode,
    country: customer.country,
  };
}

/** Trailing spaces and casing are not differences an operator should be shown. */
function same(ours: string | null, theirs: string | null): boolean {
  return (ours ?? "").trim().toLocaleLowerCase() === (theirs ?? "").trim().toLocaleLowerCase();
}

function compare(
  customer: Record<ContactField, string | null>,
  contact: HoldedContact,
): ContactDifference[] {
  return CONTACT_FIELDS.filter(
    (field) => !same(customer[field], contact[field]),
  ).map((field) => ({ field, ours: customer[field], theirs: contact[field] }));
}

async function connect(): Promise<HoldedClient | null> {
  try {
    const { secret } = await resolveIntegration("HOLDED");
    return createHoldedClient(secret);
  } catch {
    return null;
  }
}

/**
 * Reads the customer's Holded contact so an operator can see, before a document
 * is issued, whether the accounting system already knows them and agrees.
 */
export async function inspectCustomerContact(
  bookingRequestId: string,
): Promise<ContactInspection> {
  const { customer } = await loadCustomer(bookingRequestId);
  const client = await connect();
  if (!client) return { status: "no_key" };

  try {
    const contact = await client.findContactByTaxId(customer.taxId);
    if (!contact) return { status: "missing" };

    const differences = compare(
      {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        addressLine: customer.addressLine,
        city: customer.city,
        province: customer.province,
        postalCode: customer.postalCode,
        country: customer.country,
      },
      contact,
    );

    return {
      status: differences.length === 0 ? "matches" : "differs",
      contactId: contact.id,
      differences,
      estimates: await client.listEstimatesByContact(contact.id),
    };
  } catch (error) {
    logger.warn(
      {
        event: "booking_contact_inspection_failed",
        bookingRequestId,
        code: error instanceof HoldedError ? error.code : "unexpected",
      },
      "holded contact inspection failed",
    );
    return { status: "unavailable" };
  }
}

export async function createCustomerContact(bookingRequestId: string): Promise<void> {
  const { customerId, customer } = await loadCustomer(bookingRequestId);
  const { secret } = await resolveIntegration("HOLDED");

  const { id } = await createHoldedClient(secret).createContact(toInput(customer));
  await db.customer.update({ where: { id: customerId }, data: { holdedContactId: id } });

  logger.info(
    { event: "booking_contact_created", bookingRequestId, customerId },
    "holded contact created from a booking request",
  );
}

export async function updateCustomerContact(bookingRequestId: string): Promise<void> {
  const { customerId, customer } = await loadCustomer(bookingRequestId);
  const { secret } = await resolveIntegration("HOLDED");
  const client = createHoldedClient(secret);

  const contact = await client.findContactByTaxId(customer.taxId);
  if (!contact) throw new ContactSyncError("not_in_holded");

  await client.updateContact(contact.id, toInput(customer));
  await db.customer.update({
    where: { id: customerId },
    data: { holdedContactId: contact.id },
  });

  logger.info(
    { event: "booking_contact_updated", bookingRequestId, customerId },
    "holded contact updated from a booking request",
  );
}

/**
 * Records an estimate that already exists in Holded against this request, so
 * quoting leaves it alone instead of issuing a second one.
 */
export async function linkExistingEstimate(
  bookingRequestId: string,
  holdedId: string,
  actorUserId: string | null = null,
): Promise<void> {
  const { customer, state } = await loadCustomer(bookingRequestId);
  const { secret } = await resolveIntegration("HOLDED");
  const client = createHoldedClient(secret);

  const contact = await client.findContactByTaxId(customer.taxId);
  if (!contact) throw new ContactSyncError("not_in_holded");

  // Only an estimate that belongs to this customer may be attached.
  const estimates = await client.listEstimatesByContact(contact.id);
  const estimate = estimates.find((candidate) => candidate.id === holdedId);
  if (!estimate) throw new ContactSyncError("not_in_holded");

  // The document and the approval move together: a request must never end up
  // holding a contract while still sitting in review.
  await db.$transaction(async (tx) => {
    await tx.holdedDocument.upsert({
      where: { bookingRequestId_type: { bookingRequestId, type: "ESTIMATE" } },
      create: {
        bookingRequestId,
        type: "ESTIMATE",
        holdedId: estimate.id,
        documentNumber: estimate.number,
        totalCents: null,
      },
      update: { holdedId: estimate.id, documentNumber: estimate.number },
    });

    // The estimate is the contract, so a request that has one has been agreed
    // and the deposit can be asked for. Quoting is deliberately not queued: it
    // would issue a second estimate.
    if (state === "IN_REVIEW") {
      await transitionBooking(
        {
          bookingRequestId,
          to: "AWAITING_PAYMENT",
          actorUserId,
          expectedFrom: "IN_REVIEW",
        },
        tx,
      );
    }
  });

  logger.info(
    {
      event: "booking_estimate_linked",
      bookingRequestId,
      holdedId,
      approved: state === "IN_REVIEW",
    },
    "existing holded estimate linked to a booking request",
  );
}
