import "server-only";

import { z } from "zod";

import {
  executeProviderRequest,
  nativeProviderHttpClient,
  type ProviderHttpOutcome,
} from "@/lib/email/http";
import type { ProviderHttpClient } from "@/lib/email/types";

export const GRAVITY_FORMS_TIMEOUT_MS = 10_000;
export const GRAVITY_FORMS_PAGE_SIZE = 50;

/** Raw entry: field values arrive keyed by field identifier, not by label. */
const entrySchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    date_created: z.string().min(1),
  })
  .catchall(z.unknown());

const entriesResponseSchema = z.object({
  entries: z.array(entrySchema),
});

export type GravityFormsEntry = z.infer<typeof entrySchema>;

export interface GravityFormsCredentials {
  apiUrl: string;
  formId: string;
  consumerKey: string;
  consumerSecret: string;
}

export class GravityFormsError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "not_found"
      | "rate_limited"
      | "unavailable"
      | "malformed_response",
    message: string,
  ) {
    super(message);
    this.name = "GravityFormsError";
  }
}

function classify(outcome: ProviderHttpOutcome): GravityFormsError | null {
  if (outcome.kind === "network_error") {
    return new GravityFormsError("unavailable", "Gravity Forms is unreachable");
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return new GravityFormsError("unauthorized", "Gravity Forms rejected the credentials");
  }
  if (outcome.status === 404) {
    return new GravityFormsError("not_found", "Gravity Forms form not found");
  }
  if (outcome.status === 429) {
    return new GravityFormsError("rate_limited", "Gravity Forms rate limit reached");
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    return new GravityFormsError("unavailable", "Gravity Forms returned an error");
  }
  return null;
}

function entriesUrl(
  credentials: GravityFormsCredentials,
  afterEntryId: string | null,
): string {
  const base = credentials.apiUrl.replace(/\/+$/u, "");
  const url = new URL(`${base}/forms/${credentials.formId}/entries`);

  // Ascending id order with an explicit cursor: filtering by creation date
  // would skip entries whenever the WordPress and application clocks disagree.
  url.searchParams.set("sorting[key]", "id");
  url.searchParams.set("sorting[direction]", "ASC");
  url.searchParams.set("paging[page_size]", String(GRAVITY_FORMS_PAGE_SIZE));

  if (afterEntryId !== null) {
    url.searchParams.set("search[field_filters][0][key]", "id");
    url.searchParams.set("search[field_filters][0][operator]", ">");
    url.searchParams.set("search[field_filters][0][value]", afterEntryId);
  }

  return url.toString();
}

export interface GravityFormsClient {
  fetchEntriesAfter(afterEntryId: string | null): Promise<GravityFormsEntry[]>;
}

export function createGravityFormsClient(
  credentials: GravityFormsCredentials,
  httpClient: ProviderHttpClient = nativeProviderHttpClient,
): GravityFormsClient {
  const authorization = `Basic ${Buffer.from(
    `${credentials.consumerKey}:${credentials.consumerSecret}`,
  ).toString("base64")}`;

  return {
    async fetchEntriesAfter(afterEntryId) {
      const outcome = await executeProviderRequest({
        client: httpClient,
        logicalUrl: entriesUrl(credentials, afterEntryId),
        init: {
          method: "GET",
          headers: { accept: "application/json", authorization },
        },
        timeoutMs: GRAVITY_FORMS_TIMEOUT_MS,
      });

      const failure = classify(outcome);
      if (failure) throw failure;
      if (outcome.kind !== "response" || outcome.bodyTooLarge || outcome.body === null) {
        throw new GravityFormsError(
          "malformed_response",
          "Gravity Forms response could not be read",
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(outcome.body);
      } catch {
        throw new GravityFormsError(
          "malformed_response",
          "Gravity Forms returned invalid JSON",
        );
      }

      const parsed = entriesResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new GravityFormsError(
          "malformed_response",
          "Gravity Forms response did not match the expected shape",
        );
      }

      // The API sorts, but the cursor's correctness must not depend on it.
      return parsed.data.entries.toSorted((left, right) =>
        left.id.localeCompare(right.id, undefined, { numeric: true }),
      );
    },
  };
}
