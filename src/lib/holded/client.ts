import "server-only";

import { z } from "zod";

import {
  executeProviderRequest,
  nativeProviderHttpClient,
  serializeProviderJson,
  type ProviderHttpOutcome,
} from "@/lib/email/http";
import type { ProviderHttpClient } from "@/lib/email/types";

export const HOLDED_BASE_URL = "https://api.holded.com/api/invoicing/v1";
/**
 * Catalogue reads use the current API, which documents these routes and their
 * response shape. The v1 equivalents were undocumented guesses.
 */
export const HOLDED_V2_BASE_URL = "https://api.holded.com/api/v2";
export const HOLDED_TIMEOUT_MS = 15_000;
/** Bounds the contact scan so a large account cannot stall a job. */
export const HOLDED_MAX_CONTACT_PAGES = 20;
export const HOLDED_MAX_CATALOGUE_PAGES = 20;
export const HOLDED_CATALOGUE_PAGE_SIZE = 100;
/** A full chart of accounts runs past 100 kB, well over the email default. */
export const HOLDED_CATALOGUE_RESPONSE_LIMIT_BYTES = 4_194_304;

export const HOLDED_CATALOGUE_RESOURCES = [
  "services",
  "accounting-accounts",
  "payment-methods",
] as const;

export type HoldedCatalogueResource = (typeof HOLDED_CATALOGUE_RESOURCES)[number];

export class HoldedError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "not_found"
      | "rate_limited"
      | "unavailable"
      | "invalid_request"
      | "malformed_response",
    message: string,
  ) {
    super(message);
    this.name = "HoldedError";
  }
}

const contactSchema = z
  .object({
    id: z.string().min(1),
    code: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
  })
  .catchall(z.unknown());

const serviceSchema = z
  .object({
    id: z.string().min(1),
    // Holded returns money as a number; converted to cents at this boundary so
    // no float reaches the pricing engine.
    total: z.number().optional(),
    subtotal: z.number().optional(),
  })
  .catchall(z.unknown());

const documentSchema = z
  .object({
    id: z.string().min(1),
    invoiceNum: z.union([z.string(), z.number()]).optional(),
  })
  .catchall(z.unknown());

export interface HoldedContactInput {
  name: string;
  code: string;
  email: string;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface HoldedDocumentLine {
  serviceId?: string;
  name?: string;
  desc?: string;
  units: number;
  subtotal?: number;
  tax?: number;
  taxes?: string;
  accountingAccountId?: string;
}

export interface HoldedEstimateInput {
  contactCode: string;
  description: string;
  notes: string;
  language: string;
  paymentMethodId?: string;
  items: HoldedDocumentLine[];
}

export interface HoldedInvoiceInput extends HoldedEstimateInput {
  fromEstimateId: string;
  dueDate: Date;
}

export interface HoldedOption {
  id: string;
  name: string;
  /** Chart-of-accounts number, absent on catalogues that have none. */
  number?: number;
}

export interface HoldedClient {
  /** Exercises both API versions, because the two are authenticated separately. */
  ping(): Promise<void>;
  /**
   * Throws instead of returning an empty list, so the caller can tell a rejected
   * key from an account that genuinely holds no entries.
   */
  listCatalogue(resource: HoldedCatalogueResource): Promise<HoldedOption[]>;
  findContactByTaxId(taxId: string): Promise<{ id: string; email: string | null } | null>;
  createContact(input: HoldedContactInput): Promise<{ id: string }>;
  updateContactEmail(contactId: string, email: string): Promise<void>;
  getServicePriceCents(serviceId: string): Promise<number>;
  createEstimate(input: HoldedEstimateInput): Promise<{ id: string; number: string | null }>;
  sendEstimate(estimateId: string, emails: string[], mailTemplateId?: string): Promise<void>;
  createInvoiceFromEstimate(
    input: HoldedInvoiceInput,
  ): Promise<{ id: string; number: string | null }>;
  replaceEstimateLines(estimateId: string, items: HoldedDocumentLine[]): Promise<void>;
}

function classify(outcome: ProviderHttpOutcome): HoldedError | null {
  if (outcome.kind === "network_error") {
    return new HoldedError("unavailable", "Holded is unreachable");
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return new HoldedError("unauthorized", "Holded rejected the API key");
  }
  if (outcome.status === 404) {
    return new HoldedError("not_found", "Holded resource not found");
  }
  if (outcome.status === 429) {
    return new HoldedError("rate_limited", "Holded rate limit reached");
  }
  if (outcome.status === 400 || outcome.status === 422) {
    return new HoldedError("invalid_request", "Holded refused the request");
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    return new HoldedError("unavailable", "Holded returned an error");
  }
  return null;
}

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

const cataloguePageSchema = z.object({
  items: z.array(
    z
      .object({ id: z.union([z.string(), z.number()]).transform(String) })
      .catchall(z.unknown()),
  ),
  has_more: z.boolean().optional(),
  cursor: z.string().nullish(),
});

/** Every catalogue carries an id; the human label sits under a different key. */
function readCataloguePage(payload: unknown) {
  const parsed = cataloguePageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new HoldedError(
      "malformed_response",
      "Holded catalogue did not match the expected shape",
    );
  }

  const options = parsed.data.items.map((item) => {
    const label = ["name", "description", "code"]
      .map((key) => item[key])
      .find((value) => typeof value === "string" && value.trim().length > 0);

    const named = typeof label === "string" ? label.trim() : item.id;
    // A ledger account is recognised by its number, not by its name alone.
    const number = item.number;

    return typeof number === "number"
      ? { id: item.id, name: `${number} · ${named}`, number }
      : { id: item.id, name: named };
  });

  return { options, cursor: parsed.data.has_more ? (parsed.data.cursor ?? null) : null };
}

export function createHoldedClient(
  apiKey: string,
  httpClient: ProviderHttpClient = nativeProviderHttpClient,
): HoldedClient {
  async function send(
    logicalUrl: string,
    init: Record<string, unknown>,
    maxResponseBytes?: number,
  ): Promise<unknown> {
    const outcome = await executeProviderRequest({
      client: httpClient,
      logicalUrl,
      init,
      timeoutMs: HOLDED_TIMEOUT_MS,
      maxResponseBytes,
    });

    const failure = classify(outcome);
    if (failure) throw failure;
    if (outcome.kind !== "response" || outcome.bodyTooLarge || outcome.body === null) {
      throw new HoldedError("malformed_response", "Holded response could not be read");
    }

    try {
      return JSON.parse(outcome.body);
    } catch {
      throw new HoldedError("malformed_response", "Holded returned invalid JSON");
    }
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    return send(`${HOLDED_BASE_URL}${path}`, {
      method,
      headers: {
        accept: "application/json",
        key: apiKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: serializeProviderJson(body) }),
    });
  }

  async function requestV2(path: string): Promise<unknown> {
    return send(
      `${HOLDED_V2_BASE_URL}${path}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        },
      },
      HOLDED_CATALOGUE_RESPONSE_LIMIT_BYTES,
    );
  }

  return {
    async ping() {
      // Documents go through v1 and the dropdowns through v2, so a key that only
      // satisfies one of them must not be reported as verified.
      await requestV2(`/services?limit=1`);
      await request("GET", "/contacts?page=1");
    },

    async listCatalogue(resource) {
      const collected: HoldedOption[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < HOLDED_MAX_CATALOGUE_PAGES; page += 1) {
        // The chart of accounts is returned whole, and hides accounts that have
        // never moved unless asked otherwise.
        const query = new URLSearchParams(
          resource === "accounting-accounts"
            ? { include_empty: "true" }
            : { limit: String(HOLDED_CATALOGUE_PAGE_SIZE) },
        );
        if (cursor) query.set("cursor", cursor);

        const payload: unknown = await requestV2(`/${resource}?${query.toString()}`);
        const { options, cursor: next } = readCataloguePage(payload);
        collected.push(...options);

        if (!next) break;
        cursor = next;
      }

      return collected;
    },

    /**
     * Paginates and stops at the first match rather than downloading the whole
     * contact list into memory, which is how the retired workflow did it and
     * which degrades as the account grows.
     */
    async findContactByTaxId(taxId) {
      const wanted = taxId.trim().toUpperCase();

      for (let page = 1; page <= HOLDED_MAX_CONTACT_PAGES; page += 1) {
        const payload = await request("GET", `/contacts?page=${page}`);
        const parsed = z.array(contactSchema).safeParse(payload);

        if (!parsed.success) {
          throw new HoldedError(
            "malformed_response",
            "Holded contact list did not match the expected shape",
          );
        }
        if (parsed.data.length === 0) return null;

        const match = parsed.data.find(
          (contact) => contact.code?.trim().toUpperCase() === wanted,
        );
        if (match) {
          return { id: match.id, email: match.email?.trim() || null };
        }
      }

      return null;
    },

    async createContact(input) {
      const payload = await request("POST", "/contacts", {
        name: input.name,
        code: input.code,
        email: input.email,
        type: "client",
        isperson: 0,
        mobile: input.phone ?? undefined,
        address: input.address ?? undefined,
        billAddress: {
          address: input.address ?? undefined,
          city: input.city ?? undefined,
          postalCode: input.postalCode ?? undefined,
          province: input.province ?? undefined,
          country: input.country ?? undefined,
        },
      });

      const parsed = z
        .object({ id: z.string().min(1) })
        .catchall(z.unknown())
        .safeParse(payload);

      if (!parsed.success) {
        throw new HoldedError(
          "malformed_response",
          "Holded did not return an identifier for the created contact",
        );
      }
      return { id: parsed.data.id };
    },

    async updateContactEmail(contactId, email) {
      await request("PUT", `/contacts/${contactId}`, { email });
    },

    async getServicePriceCents(serviceId) {
      const payload = await request("GET", `/services/${serviceId}`);
      const parsed = serviceSchema.safeParse(payload);

      if (!parsed.success) {
        throw new HoldedError(
          "malformed_response",
          "Holded service did not match the expected shape",
        );
      }

      const price = parsed.data.total ?? parsed.data.subtotal;
      if (price === undefined || !Number.isFinite(price)) {
        throw new HoldedError(
          "malformed_response",
          "Holded service carries no usable price",
        );
      }
      return toCents(price);
    },

    async createEstimate(input) {
      const payload = await request("POST", "/documents/estimate", {
        contactCode: input.contactCode,
        date: Math.floor(Date.now() / 1000),
        desc: input.description,
        notes: input.notes,
        language: input.language,
        paymentMethodId: input.paymentMethodId,
        items: input.items,
      });

      const parsed = documentSchema.safeParse(payload);
      if (!parsed.success) {
        throw new HoldedError(
          "malformed_response",
          "Holded did not return an identifier for the estimate",
        );
      }
      return {
        id: parsed.data.id,
        number: parsed.data.invoiceNum === undefined ? null : String(parsed.data.invoiceNum),
      };
    },

    async sendEstimate(estimateId, emails, mailTemplateId) {
      await request("POST", `/documents/estimate/${estimateId}/send`, {
        emails: emails.join(","),
        mailTemplateId,
      });
    },

    async createInvoiceFromEstimate(input) {
      const payload = await request("POST", "/documents/invoice", {
        contactCode: input.contactCode,
        date: Math.floor(Date.now() / 1000),
        dueDate: Math.floor(input.dueDate.getTime() / 1000),
        desc: input.description,
        notes: input.notes,
        language: input.language,
        paymentMethodId: input.paymentMethodId,
        fromType: "estimate",
        fromId: input.fromEstimateId,
        items: input.items,
      });

      const parsed = documentSchema.safeParse(payload);
      if (!parsed.success) {
        throw new HoldedError(
          "malformed_response",
          "Holded did not return an identifier for the invoice",
        );
      }
      return {
        id: parsed.data.id,
        number: parsed.data.invoiceNum === undefined ? null : String(parsed.data.invoiceNum),
      };
    },

    async replaceEstimateLines(estimateId, items) {
      await request("PUT", `/documents/estimate/${estimateId}`, { items });
    },
  };
}
