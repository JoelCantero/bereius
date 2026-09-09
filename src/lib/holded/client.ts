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
export const HOLDED_TIMEOUT_MS = 15_000;
/** Bounds the contact scan so a large account cannot stall a job. */
export const HOLDED_MAX_CONTACT_PAGES = 20;

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
}

export interface HoldedClient {
  /** Cheapest authenticated call, used by the settings screen. */
  ping(): Promise<void>;
  listServices(): Promise<HoldedOption[]>;
  /**
   * Best-effort lookup for the settings dropdowns. Returns an empty list when
   * the endpoint is unavailable, so the screen degrades to a free-text field
   * instead of failing.
   */
  listOptions(resource: string): Promise<HoldedOption[]>;
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

const optionSchema = z
  .object({ id: z.union([z.string(), z.number()]).transform(String) })
  .catchall(z.unknown());

/** Holded names a resource differently per endpoint, so several keys are tried. */
function readOptions(payload: unknown): HoldedOption[] {
  const parsed = z.array(optionSchema).safeParse(payload);
  if (!parsed.success) return [];

  return parsed.data.map((item) => {
    const label = ["name", "desc", "title", "sku"]
      .map((key) => item[key])
      .find((value) => typeof value === "string" && value.trim().length > 0);

    return { id: item.id, name: typeof label === "string" ? label : item.id };
  });
}

export function createHoldedClient(
  apiKey: string,
  httpClient: ProviderHttpClient = nativeProviderHttpClient,
): HoldedClient {
  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const outcome = await executeProviderRequest({
      client: httpClient,
      logicalUrl: `${HOLDED_BASE_URL}${path}`,
      init: {
        method,
        headers: {
          accept: "application/json",
          key: apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: serializeProviderJson(body) }),
      },
      timeoutMs: HOLDED_TIMEOUT_MS,
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

  return {
    async ping() {
      await request("GET", "/contacts?page=1");
    },

    async listServices() {
      return readOptions(await request("GET", "/services"));
    },

    async listOptions(resource) {
      try {
        return readOptions(await request("GET", `/${resource}`));
      } catch {
        // The settings screen falls back to a text field rather than failing.
        return [];
      }
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
