// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createGravityFormsClient,
  GRAVITY_FORMS_PAGE_SIZE,
  type GravityFormsCredentials,
} from "@/lib/gravity-forms/client";
import { EMAIL_RESPONSE_LIMIT_BYTES } from "@/lib/email/types";
import { createHttpMailProvider, type FakeProviderBehavior } from "../helpers/http-mail-provider";

const CREDENTIALS: GravityFormsCredentials = {
  apiUrl: "https://berea.example/wp-json/gf/v2///",
  formId: "2",
  consumerKey: "ck_test",
  consumerSecret: "cs_test",
};

function page(body: unknown): FakeProviderBehavior {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function status(code: number): FakeProviderBehavior {
  return { status: code, headers: { "content-type": "application/json" }, body: "{}" };
}

function gravity(behaviors: FakeProviderBehavior[]) {
  const http = createHttpMailProvider(behaviors);
  return { http, client: createGravityFormsClient(CREDENTIALS, http.client) };
}

async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return (error as { code?: string }).code ?? "not-a-gravity-forms-error";
  }
  throw new Error("expected the call to be refused");
}

describe("Gravity Forms entries", () => {
  it("authenticates with the consumer pair over basic auth", async () => {
    const { http, client } = gravity([page({ entries: [] })]);

    await client.fetchEntriesAfter(null);

    expect(http.requests[0].headers.get("authorization")).toBe(
      `Basic ${Buffer.from("ck_test:cs_test").toString("base64")}`,
    );
  });

  it("addresses the form's entry collection whatever trailing slashes the base carries", async () => {
    const { http, client } = gravity([page({ entries: [] })]);

    await client.fetchEntriesAfter(null);

    const url = new URL(http.requests[0].logicalUrl);
    expect(url.origin + url.pathname).toBe(
      "https://berea.example/wp-json/gf/v2/forms/2/entries",
    );
  });

  // Filtering by creation date would skip entries whenever the WordPress and
  // application clocks disagree, so the cursor is the entry id.
  it("asks for ascending identifiers rather than ordering by date", async () => {
    const { http, client } = gravity([page({ entries: [] })]);

    await client.fetchEntriesAfter(null);

    const { searchParams } = new URL(http.requests[0].logicalUrl);
    expect(searchParams.get("sorting[key]")).toBe("id");
    expect(searchParams.get("sorting[direction]")).toBe("ASC");
    expect(searchParams.get("paging[page_size]")).toBe(String(GRAVITY_FORMS_PAGE_SIZE));
    expect(searchParams.get("search[field_filters][0][key]")).toBeNull();
  });

  it("filters on the stored cursor once one exists", async () => {
    const { http, client } = gravity([page({ entries: [] })]);

    await client.fetchEntriesAfter("417");

    const { searchParams } = new URL(http.requests[0].logicalUrl);
    expect(searchParams.get("search[field_filters][0][key]")).toBe("id");
    expect(searchParams.get("search[field_filters][0][operator]")).toBe(">");
    expect(searchParams.get("search[field_filters][0][value]")).toBe("417");
  });

  it("accepts a numeric identifier and reports it as a string", async () => {
    const { client } = gravity([
      page({ entries: [{ id: 418, date_created: "2026-07-01 10:00:00" }] }),
    ]);

    await expect(client.fetchEntriesAfter(null)).resolves.toEqual([
      { id: "418", date_created: "2026-07-01 10:00:00" },
    ]);
  });

  it("keeps the unmapped field values, which are keyed by field identifier", async () => {
    const { client } = gravity([
      page({ entries: [{ id: "1", date_created: "2026-07-01 10:00:00", "12.3": "Berga" }] }),
    ]);

    const [entry] = await client.fetchEntriesAfter(null);

    expect(entry["12.3"]).toBe("Berga");
  });

  // The cursor advances entry by entry, so its correctness must not depend on
  // the server having honoured the sort.
  it("orders entries numerically even when the API does not", async () => {
    const { client } = gravity([
      page({
        entries: [
          { id: "100", date_created: "2026-07-03 10:00:00" },
          { id: "9", date_created: "2026-07-01 10:00:00" },
          { id: "20", date_created: "2026-07-02 10:00:00" },
        ],
      }),
    ]);

    const entries = await client.fetchEntriesAfter(null);

    expect(entries.map((entry) => entry.id)).toEqual(["9", "20", "100"]);
  });

  it.each([
    [status(401), "unauthorized"],
    [status(403), "unauthorized"],
    [status(404), "not_found"],
    [status(429), "rate_limited"],
    [status(500), "unavailable"],
    [status(302), "unavailable"],
    [{ error: new Error("socket hang up") } as FakeProviderBehavior, "unavailable"],
  ])("reports %o as %s", async (behavior, expected) => {
    const { client } = gravity([behavior]);

    await expect(codeOf(client.fetchEntriesAfter(null))).resolves.toBe(expected);
  });

  it("refuses a body that is not JSON", async () => {
    const { client } = gravity([
      { status: 200, headers: { "content-type": "text/html" }, body: "<html>login</html>" },
    ]);

    await expect(codeOf(client.fetchEntriesAfter(null))).resolves.toBe(
      "malformed_response",
    );
  });

  it.each([[{ entries: [{ date_created: "2026-07-01" }] }], [{ items: [] }]])(
    "refuses %o, which is not an entry list",
    async (payload) => {
      const { client } = gravity([page(payload)]);

      await expect(codeOf(client.fetchEntriesAfter(null))).resolves.toBe(
        "malformed_response",
      );
    },
  );

  // Entry reads keep the default budget, so an oversized page is refused
  // rather than silently truncated into a cursor that skips submissions.
  it("refuses a page larger than the response budget", async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 25 }, (_, field) => [
        String(field + 1),
        "Un valor de camp prou llarg per abultar la resposta sencera",
      ]),
    );
    const entries = Array.from({ length: GRAVITY_FORMS_PAGE_SIZE }, (_, index) => ({
      id: String(index),
      date_created: "2026-07-01 10:00:00",
      ...fields,
    }));
    const body = JSON.stringify({ entries });
    expect(Buffer.byteLength(body)).toBeGreaterThan(EMAIL_RESPONSE_LIMIT_BYTES);

    const { client } = gravity([
      { status: 200, headers: { "content-type": "application/json" }, body },
    ]);

    await expect(codeOf(client.fetchEntriesAfter(null))).resolves.toBe(
      "malformed_response",
    );
  });
});
