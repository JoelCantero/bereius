import "server-only";

import { z } from "zod";

import {
  executeProviderRequest,
  nativeProviderHttpClient,
  serializeProviderJson,
  type ProviderHttpOutcome,
} from "@/lib/email/http";
import type { ProviderHttpClient } from "@/lib/email/types";

/**
 * v1 rejects keys issued today with `{"status":0,"info":"Invalid key"}`, so the
 * whole client speaks v2. Holded documents v1 as archived for existing work.
 */
export const HOLDED_BASE_URL = "https://api.holded.com/api/v2";
export const HOLDED_TIMEOUT_MS = 15_000;
export const HOLDED_MAX_CATALOGUE_PAGES = 20;
export const HOLDED_CATALOGUE_PAGE_SIZE = 100;
/** A catalogue listing runs past 100 kB, well beyond the email default. */
export const HOLDED_CATALOGUE_RESPONSE_LIMIT_BYTES = 4_194_304;

/**
 * A document line's `account` holds a sales channel id, not a ledger account
 * id: the channel is what Holded maps onto a chart-of-accounts number.
 */
export const HOLDED_CATALOGUE_RESOURCES = [
  "services",
  "sales-channels",
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
    code: z.string().nullish(),
    email: z.string().nullish(),
    name: z.string().nullish(),
  })
  .catchall(z.unknown());

const serviceSchema = z
  .object({
    id: z.string().min(1),
    // Reads return money as a decimal string; converted to cents here so no
    // float reaches the pricing engine.
    price: z.union([z.string(), z.number()]).optional(),
  })
  .catchall(z.unknown());

/** Creates answer with the identifier alone; the number needs a second read. */
const createdSchema = z.object({ id: z.string().min(1) }).catchall(z.unknown());

const documentSchema = z
  .object({
    id: z.string().min(1),
    document_number: z.string().nullish(),
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
  name?: string;
  description?: string;
  serviceId?: string;
  units: number;
  /** Net unit price; documents are issued with tax excluded. */
  price: number;
  taxes?: string[];
  salesChannelId?: string;
}

export interface HoldedDocumentInput {
  contactId: string;
  description: string;
  notes: string;
  language: string;
  paymentMethodId?: string;
  items: HoldedDocumentLine[];
}

export interface HoldedInvoiceInput extends HoldedDocumentInput {
  dueDate: Date;
}

export interface HoldedOption {
  id: string;
  name: string;
  /** Chart-of-accounts number, absent on catalogues that have none. */
  number?: number;
}

export interface HoldedDocumentResult {
  id: string;
  number: string | null;
}

export interface HoldedClient {
  /** Cheapest authenticated call, used by the settings screen. */
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
  createEstimate(input: HoldedDocumentInput): Promise<HoldedDocumentResult>;
  sendEstimate(estimateId: string, emails: string[], mailTemplateId?: string): Promise<void>;
  createInvoice(input: HoldedInvoiceInput): Promise<HoldedDocumentResult>;
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

/**
 * Reads a Holded decimal. Catalogue prices arrive as `"30.9091"` but document
 * amounts as `"461,82"`, so whichever separator comes last is the decimal one.
 */
function parseDecimal(value: string | number | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const lastComma = trimmed.lastIndexOf(",");
  const lastDot = trimmed.lastIndexOf(".");
  const normalised =
    lastComma > lastDot
      ? trimmed.replace(/\./gu, "").replace(",", ".")
      : trimmed.replace(/,/gu, "");

  const parsed = Number(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function today(): string {
  return isoDate(new Date());
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
    // A sales channel is only meaningful alongside the ledger account it posts
    // to, which it reports as `account_num`.
    const number = typeof item.number === "number" ? item.number : item.account_num;

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
    return send(
      `${HOLDED_BASE_URL}${path}`,
      {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: serializeProviderJson(body) }),
      },
      HOLDED_CATALOGUE_RESPONSE_LIMIT_BYTES,
    );
  }

  function toLine(line: HoldedDocumentLine): Record<string, unknown> {
    return {
      name: line.name,
      description: line.description,
      service_id: line.serviceId,
      units: line.units,
      price: line.price,
      discount: 0,
      taxes: line.taxes ?? [],
      account: line.salesChannelId,
    };
  }

  /** Creates return the identifier only; the number needs a second read. */
  async function readDocumentNumber(
    collection: string,
    id: string,
  ): Promise<string | null> {
    const parsed = documentSchema.safeParse(await request("GET", `/${collection}/${id}`));
    return parsed.success ? (parsed.data.document_number ?? null) : null;
  }

  async function createDocument(
    collection: string,
    body: Record<string, unknown>,
  ): Promise<HoldedDocumentResult> {
    const parsed = createdSchema.safeParse(await request("POST", `/${collection}`, body));
    if (!parsed.success) {
      throw new HoldedError(
        "malformed_response",
        `Holded did not return an identifier for the ${collection} document`,
      );
    }

    return {
      id: parsed.data.id,
      number: await readDocumentNumber(collection, parsed.data.id),
    };
  }

  return {
    async ping() {
      await request("GET", "/services?limit=1");
    },

    async listCatalogue(resource) {
      const collected: HoldedOption[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < HOLDED_MAX_CATALOGUE_PAGES; page += 1) {
        const query = new URLSearchParams({
          limit: String(HOLDED_CATALOGUE_PAGE_SIZE),
        });
        if (cursor) query.set("cursor", cursor);

        const payload: unknown = await request("GET", `/${resource}?${query.toString()}`);
        const { options, cursor: next } = readCataloguePage(payload);
        collected.push(...options);

        if (!next) break;
        cursor = next;
      }

      return collected;
    },

    /** The tax id is an exact-match filter, so no scan is needed. */
    async findContactByTaxId(taxId) {
      const query = new URLSearchParams({ code: taxId.trim(), limit: "1" });
      const payload = await request("GET", `/contacts?${query.toString()}`);
      const parsed = z
        .object({ items: z.array(contactSchema) })
        .catchall(z.unknown())
        .safeParse(payload);

      if (!parsed.success) {
        throw new HoldedError(
          "malformed_response",
          "Holded contact list did not match the expected shape",
        );
      }

      const [match] = parsed.data.items;
      return match ? { id: match.id, email: match.email?.trim() || null } : null;
    },

    async createContact(input) {
      const payload = await request("POST", "/contacts", {
        name: input.name,
        code: input.code,
        email: input.email,
        phone: input.phone ?? undefined,
        type: "client",
        is_person: false,
        bill_address: {
          address: input.address ?? undefined,
          city: input.city ?? undefined,
          postal_code: input.postalCode ?? undefined,
          province: input.province ?? undefined,
          country: input.country ?? undefined,
        },
      });

      const parsed = createdSchema.safeParse(payload);
      if (!parsed.success) {
        throw new HoldedError(
          "malformed_response",
          "Holded did not return an identifier for the created contact",
        );
      }
      return { id: parsed.data.id };
    },

    /**
     * The endpoint replaces every mutable field, so the contact is read back and
     * returned whole; sending the email alone would blank the rest.
     */
    async updateContactEmail(contactId, email) {
      const current = await request("GET", `/contacts/${contactId}`);
      const parsed = contactSchema.safeParse(current);

      if (!parsed.success) {
        throw new HoldedError(
          "malformed_response",
          "Holded contact did not match the expected shape",
        );
      }

      const mutable = { ...parsed.data };
      delete (mutable as { id?: unknown }).id;
      await request("PUT", `/contacts/${contactId}`, { ...mutable, email });
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

      const price = parseDecimal(parsed.data.price);
      if (price === null) {
        throw new HoldedError(
          "malformed_response",
          "Holded service carries no usable price",
        );
      }
      return toCents(price);
    },

    async createEstimate(input) {
      return createDocument("estimates", {
        contact_id: input.contactId,
        date: today(),
        description: input.description,
        notes: input.notes,
        language: input.language,
        currency: "EUR",
        tax_included: false,
        payment_method_id: input.paymentMethodId,
        items: input.items.map(toLine),
      });
    },

    async sendEstimate(estimateId, emails, mailTemplateId) {
      // The success response carries no body, so nothing is parsed.
      await request("POST", `/estimates/${estimateId}/send`, {
        emails,
        mail_template_id: mailTemplateId,
      });
    },

    async createInvoice(input) {
      return createDocument("invoices", {
        contact_id: input.contactId,
        date: today(),
        due_date: isoDate(input.dueDate),
        description: input.description,
        notes: input.notes,
        language: input.language,
        currency: "EUR",
        payment_method_id: input.paymentMethodId,
        items: input.items.map(toLine),
      });
    },

    async replaceEstimateLines(estimateId, items) {
      // Sending `items` replaces the whole collection; there is no line patch.
      await request("PUT", `/estimates/${estimateId}`, {
        tax_included: false,
        items: items.map(toLine),
      });
    },
  };
}
