// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createHoldedClient,
  HOLDED_BASE_URL,
  HOLDED_MAX_CATALOGUE_PAGES,
} from "@/lib/holded/client";
import { EMAIL_RESPONSE_LIMIT_BYTES } from "@/lib/email/types";
import { createHttpMailProvider } from "../helpers/http-mail-provider";

function page(body: unknown) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("Holded catalogue reads", () => {
  it("asks the documented endpoint with a bearer credential", async () => {
    const http = createHttpMailProvider([
      page({ items: [{ id: "svc-1", name: "Pensió completa" }], has_more: false }),
    ]);
    const client = createHoldedClient("secret-key", http.client);

    const options = await client.listCatalogue("services");

    expect(options).toEqual([{ id: "svc-1", name: "Pensió completa" }]);
    const [request] = http.requests;
    expect(request.logicalUrl.startsWith(`${HOLDED_BASE_URL}/services?`)).toBe(true);
    expect(request.headers.get("authorization")).toBe("Bearer secret-key");
  });

  it.each(["sales-channels", "payment-methods"] as const)(
    "reads the %s catalogue from its own route",
    async (resource) => {
      const http = createHttpMailProvider([page({ items: [], has_more: false })]);

      await createHoldedClient("secret-key", http.client).listCatalogue(resource);

      expect(http.requests[0].logicalUrl).toContain(`${HOLDED_BASE_URL}/${resource}?`);
    },
  );

  it("labels a sales channel with the ledger account it posts to", async () => {
    const http = createHttpMailProvider([
      page({
        items: [{ id: "ch-1", name: "Casa de colònies Berea", account_num: 70500001 }],
        has_more: false,
      }),
    ]);

    const options = await createHoldedClient("k", http.client).listCatalogue(
      "sales-channels",
    );

    expect(options).toEqual([
      { id: "ch-1", name: "70500001 · Casa de colònies Berea", number: 70500001 },
    ]);
  });

  it("follows the cursor until the account is exhausted", async () => {
    const http = createHttpMailProvider([
      page({ items: [{ id: "a", name: "A" }], has_more: true, cursor: "next-page" }),
      page({ items: [{ id: "b", name: "B" }], has_more: false, cursor: null }),
    ]);

    const options = await createHoldedClient("k", http.client).listCatalogue("services");

    expect(options.map((option) => option.id)).toEqual(["a", "b"]);
    expect(http.requests[1].logicalUrl).toContain("cursor=next-page");
  });

  it("stops paginating so a runaway cursor cannot spin forever", async () => {
    const http = createHttpMailProvider(
      Array.from({ length: HOLDED_MAX_CATALOGUE_PAGES + 5 }, () =>
        page({ items: [{ id: "x", name: "X" }], has_more: true, cursor: "same" }),
      ),
    );

    await createHoldedClient("k", http.client).listCatalogue("services");

    expect(http.requests).toHaveLength(HOLDED_MAX_CATALOGUE_PAGES);
  });

  it("falls back to the code, then the identifier, when an entry has no name", async () => {
    const http = createHttpMailProvider([
      page({
        items: [{ id: "a", code: "SRV-001" }, { id: "b" }, { id: "c", name: "   " }],
        has_more: false,
      }),
    ]);

    const options = await createHoldedClient("k", http.client).listCatalogue("services");

    expect(options).toEqual([
      { id: "a", name: "SRV-001" },
      { id: "b", name: "b" },
      { id: "c", name: "c" },
    ]);
  });

  it("reads a chart of accounts far larger than the email response budget", async () => {
    const items = Array.from({ length: 456 }, (_, index) => ({
      id: `acc-${index}`,
      number: 40000000 + index,
      name: "Cuenta con un nombre suficientemente largo para abultar la respuesta",
      group: "Clientes y proveedores",
    }));
    const body = JSON.stringify({ items });
    expect(Buffer.byteLength(body)).toBeGreaterThan(EMAIL_RESPONSE_LIMIT_BYTES);

    const http = createHttpMailProvider([
      { status: 200, headers: { "content-type": "application/json" }, body },
    ]);

    const options = await createHoldedClient("k", http.client).listCatalogue(
      "sales-channels",
    );

    expect(options).toHaveLength(456);
  });

  it("verifies the key against the API the whole client now uses", async () => {
    const http = createHttpMailProvider([page({ items: [], has_more: false })]);

    await createHoldedClient("k", http.client).ping();

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].logicalUrl).toContain(`${HOLDED_BASE_URL}/services`);
    expect(http.requests[0].headers.get("authorization")).toBe("Bearer k");
  });

  it("reports a refused key instead of passing off an empty catalogue", async () => {
    const http = createHttpMailProvider([
      { status: 401, headers: { "content-type": "application/json" }, body: "{}" },
    ]);

    await expect(
      createHoldedClient("k", http.client).listCatalogue("services"),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});
