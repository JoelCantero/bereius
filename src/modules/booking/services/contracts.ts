import "server-only";

import type { BookingState } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import {
  createHoldedClient,
  HoldedError,
  type HoldedClient,
  type HoldedEstimateSummary,
} from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import { resolveIntegration } from "@/modules/booking/services/settings";

/** States that can still receive a contract; a closed request must not. */
const LINKABLE_STATES: BookingState[] = ["IN_REVIEW", "AWAITING_PAYMENT", "CONFIRMED"];

export interface ContractLink {
  bookingRequestId: string;
  customerName: string;
  state: BookingState;
}

export interface Contract extends HoldedEstimateSummary {
  link: ContractLink | null;
}

export interface ContractCandidate {
  id: string;
  customerName: string;
  state: BookingState;
  startDate: Date;
  endDate: Date;
  headcount: number;
  /** The estimate's own description names these dates, so this is likely the one. */
  suggested: boolean;
}

export type ContractList =
  | { status: "no_key" | "unavailable" }
  | { status: "ok"; contracts: Contract[] };

export type ContractDetail =
  | { status: "no_key" | "unavailable" | "missing" }
  | {
      status: "linked";
      contract: Contract;
      link: ContractLink;
    }
  | {
      status: "unlinked";
      contract: Contract;
      /** Null when Holded holds no tax id for the contact, which blocks matching. */
      taxId: string | null;
      candidates: ContractCandidate[];
    };

async function connect(): Promise<HoldedClient | null> {
  try {
    const { secret } = await resolveIntegration("HOLDED");
    return createHoldedClient(secret);
  } catch {
    return null;
  }
}

function report(event: string, error: unknown, extra: Record<string, unknown> = {}) {
  logger.warn(
    { event, ...extra, code: error instanceof HoldedError ? error.code : "unexpected" },
    "holded contract read failed",
  );
}

/** Every estimate this account holds, each marked with the request it belongs to. */
export async function listContracts(): Promise<ContractList> {
  const client = await connect();
  if (!client) return { status: "no_key" };

  try {
    const [estimates, documents] = await Promise.all([
      client.listEstimates(),
      db.holdedDocument.findMany({
        where: { type: "ESTIMATE" },
        select: {
          holdedId: true,
          bookingRequestId: true,
          bookingRequest: {
            select: { state: true, customer: { select: { name: true } } },
          },
        },
      }),
    ]);

    const links = new Map<string, ContractLink>(
      documents.map((document) => [
        document.holdedId,
        {
          bookingRequestId: document.bookingRequestId,
          customerName: document.bookingRequest.customer.name,
          state: document.bookingRequest.state,
        },
      ]),
    );

    return {
      status: "ok",
      contracts: estimates.map((estimate) => ({
        ...estimate,
        link: links.get(estimate.id) ?? null,
      })),
    };
  } catch (error) {
    report("booking_contract_list_failed", error);
    return { status: "unavailable" };
  }
}

async function readLink(holdedId: string): Promise<ContractLink | null> {
  const document = await db.holdedDocument.findFirst({
    where: { holdedId, type: "ESTIMATE" },
    select: {
      bookingRequestId: true,
      bookingRequest: { select: { state: true, customer: { select: { name: true } } } },
    },
  });

  return document
    ? {
        bookingRequestId: document.bookingRequestId,
        customerName: document.bookingRequest.customer.name,
        state: document.bookingRequest.state,
      }
    : null;
}

/** The shape the retired workflow wrote into every estimate description. */
function shortDate(value: Date): string {
  const day = String(value.getUTCDate()).padStart(2, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${String(value.getUTCFullYear()).slice(2)}`;
}

/**
 * Whether an estimate's description names this stay. A hint for the operator,
 * never a decision: the description is free text and may be edited in Holded.
 */
export function estimateNamesStay(
  description: string | null,
  startDate: Date,
  endDate: Date,
): boolean {
  return (
    description !== null &&
    description.includes(shortDate(startDate)) &&
    description.includes(shortDate(endDate))
  );
}

/**
 * Requests that may take this contract: the tax id on the Holded contact is the
 * only accepted match, so an estimate cannot be attached to another customer.
 */
async function findCandidates(
  taxId: string,
  description: string | null,
): Promise<ContractCandidate[]> {
  const customer = await db.customer.findUnique({
    where: { taxId },
    select: {
      name: true,
      bookingRequests: {
        where: {
          state: { in: LINKABLE_STATES },
          documents: { none: { type: "ESTIMATE" } },
        },
        orderBy: { submittedAt: "desc" },
        select: {
          id: true,
          state: true,
          startDate: true,
          endDate: true,
          headcount: true,
        },
      },
    },
  });

  return (customer?.bookingRequests ?? [])
    .map((booking) => ({
      ...booking,
      customerName: customer?.name ?? "",
      suggested: estimateNamesStay(description, booking.startDate, booking.endDate),
    }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested));
}

export async function readContract(holdedId: string): Promise<ContractDetail> {
  const client = await connect();
  if (!client) return { status: "no_key" };

  try {
    const estimate = await client.getEstimate(holdedId);
    if (!estimate) return { status: "missing" };

    const link = await readLink(holdedId);
    const contract: Contract = { ...estimate, link };
    if (link) return { status: "linked", contract, link };

    const contact = estimate.contactId ? await client.getContact(estimate.contactId) : null;
    const taxId = contact?.taxId ?? null;

    return {
      status: "unlinked",
      contract,
      taxId,
      candidates: taxId ? await findCandidates(taxId, estimate.description) : [],
    };
  } catch (error) {
    report("booking_contract_read_failed", error, { holdedId });
    return { status: "unavailable" };
  }
}
