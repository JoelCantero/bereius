// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createHoldedClient, HOLDED_BASE_URL } from "@/lib/holded/client";
import { createHttpMailProvider, type FakeProviderBehavior } from "../helpers/http-mail-provider";

function page(body: unknown): FakeProviderBehavior {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function status(code: number): FakeProviderBehavior {
  return {
    status: code,
    headers: { "content-type": "application/json" },
    body: "{}",
  };
}

function holded(behaviors: FakeProviderBehavior[]) {
  const http = createHttpMailProvider(behaviors);
  return { http, client: createHoldedClient("k", http.client) };
}

function sentBody(raw: string | null): unknown {
  return raw === null ? null : JSON.parse(raw);
}

/** Reports the failure code, so a test cannot pass by not failing at all. */
async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return (error as { code?: string }).code ?? "not-a-holded-error";
  }
  throw new Error("expected the call to be refused");
}

describe("Holded failure classification", () => {
  it.each([
    [status(403), "unauthorized"],
    [status(404), "not_found"],
    [status(429), "rate_limited"],
    [status(400), "invalid_request"],
    [status(422), "invalid_request"],
    [status(500), "unavailable"],
    [status(302), "unavailable"],
    [{ error: new Error("socket hang up") } as FakeProviderBehavior, "unavailable"],
  ])("reports %o as %s", async (behavior, expected) => {
    const { client } = holded([behavior]);

    await expect(codeOf(client.ping())).resolves.toBe(expected);
  });

  it("refuses a body that is not JSON rather than passing it on", async () => {
    const { client } = holded([
      { status: 200, headers: { "content-type": "text/html" }, body: "<html>oops</html>" },
    ]);

    await expect(codeOf(client.ping())).resolves.toBe("malformed_response");
  });
});

describe("Holded numbering series", () => {
  it("reads the series of one document type from its own route", async () => {
    const { http, client } = holded([page({ items: [{ id: "s1", name: "E" }] })]);

    await expect(client.listNumberingSeries("estimate")).resolves.toEqual([
      { id: "s1", name: "E" },
    ]);
    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/numbering-series/estimate`);
  });

  it("refuses a payload that is not a list of series", async () => {
    const { client } = holded([page({ unexpected: true })]);

    await expect(codeOf(client.listNumberingSeries("invoice"))).resolves.toBe(
      "malformed_response",
    );
  });
});

describe("Holded contacts", () => {
  // The retired workflow downloaded every contact to find one tax identifier.
  it("looks a contact up with an exact filter rather than a scan", async () => {
    const { http, client } = holded([
      page({
        items: [
          {
            id: "c1",
            name: "  Escola Pia  ",
            code: "G12345678",
            email: " hola@example.test ",
            mobile: "600111222",
            bill_address: { address: "Carrer Major 1", city: "Berga" },
          },
        ],
      }),
    ]);

    await expect(client.findContactByTaxId("  G12345678 ")).resolves.toEqual({
      id: "c1",
      name: "Escola Pia",
      taxId: "G12345678",
      // Holded keeps two numbers and the retired workflow filled the mobile one.
      phone: "600111222",
      email: "hola@example.test",
      addressLine: "Carrer Major 1",
      city: "Berga",
      province: null,
      postalCode: null,
      country: null,
    });
    expect(http.requests[0].logicalUrl).toContain("code=G12345678");
    expect(http.requests[0].logicalUrl).toContain("limit=1");
  });

  it("returns null when the tax identifier matches nobody", async () => {
    const { client } = holded([page({ items: [] })]);

    await expect(client.findContactByTaxId("G00000000")).resolves.toBeNull();
  });

  it("refuses a contact list that is not shaped like one", async () => {
    const { client } = holded([page({ items: [{ missing: "id" }] })]);

    await expect(codeOf(client.findContactByTaxId("G1"))).resolves.toBe(
      "malformed_response",
    );
  });

  it("reads a contact by identifier", async () => {
    const { client } = holded([page({ id: "c1", name: "Casal", phone: "938000000" })]);

    await expect(client.getContact("c1")).resolves.toMatchObject({
      id: "c1",
      name: "Casal",
      phone: "938000000",
    });
  });

  it("reports an absent contact as null instead of raising", async () => {
    const { client } = holded([status(404)]);

    await expect(client.getContact("gone")).resolves.toBeNull();
  });

  it("still raises when the failure is not a missing contact", async () => {
    const { client } = holded([status(401)]);

    await expect(codeOf(client.getContact("c1"))).resolves.toBe("unauthorized");
  });

  it("returns null when the record does not parse as a contact", async () => {
    const { client } = holded([page({ no_id: true })]);

    await expect(client.getContact("c1")).resolves.toBeNull();
  });

  it("creates a contact as a company client", async () => {
    const { http, client } = holded([page({ id: "new-1" })]);

    await expect(
      client.createContact({
        name: "Agrupament",
        code: "G87654321",
        email: "cap@example.test",
        postalCode: "08600",
      }),
    ).resolves.toEqual({ id: "new-1" });

    expect(http.requests[0].method).toBe("POST");
    expect(sentBody(http.requests[0].body)).toMatchObject({
      name: "Agrupament",
      code: "G87654321",
      type: "client",
      is_person: false,
      bill_address: { postal_code: "08600" },
    });
  });

  it("refuses a create that answers without an identifier", async () => {
    const { client } = holded([page({ ok: true })]);

    await expect(
      codeOf(client.createContact({ name: "X", code: "G1", email: "x@example.test" })),
    ).resolves.toBe("malformed_response");
  });

  // A partial write blanks every field it omits, the tax identifier and the
  // bank details included, so the record is read back and merged.
  it("merges an update onto the stored record", async () => {
    const { http, client } = holded([
      page({
        id: "c1",
        name: "Old",
        code: "G1",
        email: "old@example.test",
        iban: "ES00",
        client_record: { num: 43000001, name: "Clients" },
        supplier_record: { num: 40000001 },
        created_at: 1,
        updated_at: 2,
        rate: { id: "r1" },
        bill_address: { address: "Old street", country: "ES" },
      }),
      page({}),
    ]);

    await client.updateContact("c1", {
      name: "New",
      code: "G1",
      email: "new@example.test",
      address: "New street",
    });

    const update = http.requests[1];
    expect(update.method).toBe("PUT");
    // Records are objects when read and plain numbers when written.
    expect(sentBody(update.body)).toMatchObject({
      iban: "ES00",
      name: "New",
      email: "new@example.test",
      client_record: 43000001,
      supplier_record: 40000001,
      phone: null,
      bill_address: { address: "New street", country: null },
    });
    expect(sentBody(update.body)).not.toHaveProperty("id");
    expect(sentBody(update.body)).not.toHaveProperty("created_at");
    expect(sentBody(update.body)).not.toHaveProperty("rate");
  });

  it("refuses to update a record it could not read back", async () => {
    const { client } = holded([page({ no_id: true })]);

    await expect(
      codeOf(client.updateContact("c1", { name: "N", code: "G1", email: "n@example.test" })),
    ).resolves.toBe("malformed_response");
  });
});

describe("Holded estimate reads", () => {
  it("lists the estimates of one contact", async () => {
    const { http, client } = holded([
      page({
        items: [
          {
            id: "e1",
            document_number: " E-2026-1 ",
            description: " Stay ",
            date: "2026-07-01",
            total: "461,82",
            status: "approved",
            contact_id: "c1",
            contact_name: " Escola ",
          },
        ],
      }),
    ]);

    await expect(client.listEstimatesByContact("c1")).resolves.toEqual([
      {
        id: "e1",
        number: "E-2026-1",
        description: "Stay",
        date: "2026-07-01",
        totalCents: 46182,
        status: "approved",
        contactId: "c1",
        contactName: "Escola",
      },
    ]);
    expect(http.requests[0].logicalUrl).toContain("contact_id=c1");
  });

  // A server that ignored the filter must not put another customer's document
  // in front of an operator.
  it("drops rows belonging to a different contact", async () => {
    const { client } = holded([
      page({ items: [{ id: "e1", contact_id: "c1" }, { id: "e2", contact_id: "c2" }] }),
    ]);

    const estimates = await client.listEstimatesByContact("c1");

    expect(estimates.map((estimate) => estimate.id)).toEqual(["e1"]);
  });

  it("refuses an estimate list that is not shaped like one", async () => {
    const { client } = holded([page({ items: [{ nope: true }] })]);

    await expect(codeOf(client.listEstimatesByContact("c1"))).resolves.toBe(
      "malformed_response",
    );
  });

  it("pages the whole estimate ledger", async () => {
    const { http, client } = holded([
      page({ items: [{ id: "e1" }], has_more: true, cursor: "next" }),
      page({ items: [{ id: "e2" }], has_more: false }),
    ]);

    const estimates = await client.listEstimates();

    expect(estimates.map((estimate) => estimate.id)).toEqual(["e1", "e2"]);
    expect(http.requests[1].logicalUrl).toContain("cursor=next");
  });

  it("refuses a malformed page of the ledger", async () => {
    const { client } = holded([page({ items: "not an array" })]);

    await expect(codeOf(client.listEstimates())).resolves.toBe("malformed_response");
  });

  it("reports an absent estimate as null", async () => {
    const { client } = holded([status(404)]);

    await expect(client.getEstimate("gone")).resolves.toBeNull();
  });

  it("propagates a failure that is not a missing estimate", async () => {
    const { client } = holded([status(429)]);

    await expect(codeOf(client.getEstimate("e1"))).resolves.toBe("rate_limited");
  });

  it("returns null for a record that does not parse as an estimate", async () => {
    const { client } = holded([page({ nope: true })]);

    await expect(client.getEstimate("e1")).resolves.toBeNull();
  });

  it("leaves the total unset when the document carries none", async () => {
    const { client } = holded([page({ id: "e1", contact_id: "c1" })]);

    await expect(client.getEstimate("e1")).resolves.toMatchObject({
      totalCents: null,
      number: null,
    });
  });
});

describe("Holded service prices", () => {
  // Catalogue prices arrive as "30.9091" but document amounts as "461,82", so
  // whichever separator comes last is the decimal one.
  it.each([
    ["30.9091", 3091],
    ["461,82", 46182],
    ["1.234,56", 123456],
    ["1,234.56", 123456],
    ["12", 1200],
    [30.9091, 3091],
  ])("reads %o as %i cents", async (price, expected) => {
    const { client } = holded([page({ id: "s1", price })]);

    await expect(client.readService("s1")).resolves.toMatchObject({
      priceCents: expected,
    });
  });

  it.each([[undefined], ["not a price"], [Number.NaN]])(
    "refuses %o as a price",
    async (price) => {
      const { client } = holded([page({ id: "s1", price })]);

      await expect(codeOf(client.readService("s1"))).resolves.toBe(
        "malformed_response",
      );
    },
  );

  it("reads the accounting account the service declares", async () => {
    const { client } = holded([
      page({ id: "s1", price: "200", sales_channel_id: "acct-1" }),
    ]);

    await expect(client.readService("s1")).resolves.toMatchObject({
      accountId: "acct-1",
    });
  });

  it("reports a service with no account rather than inventing one", async () => {
    const { client } = holded([page({ id: "s1", price: "200" })]);

    await expect(client.readService("s1")).resolves.toMatchObject({
      accountId: null,
    });
  });

  it("refuses a service record without an identifier", async () => {
    const { client } = holded([page({ price: "10" })]);

    await expect(codeOf(client.readService("s1"))).resolves.toBe(
      "malformed_response",
    );
  });
});

describe("Holded document writes", () => {
  it("creates an estimate and reads back the number the series assigned", async () => {
    const { http, client } = holded([
      page({ id: "e1" }),
      page({ id: "e1", document_number: "EST-7" }),
    ]);

    await expect(
      client.createEstimate({
        contactId: "c1",
        description: "Stay",
        notes: "",
        language: "ca",
        numberingSeriesId: "series-e",
        paymentMethodId: "pm1",
        items: [
          {
            name: "Pensió completa",
            serviceId: "svc1",
            units: 60,
            price: 30.91,
            taxes: ["s_iva_10"],
            accountId: "ch1",
          },
        ],
      }),
    ).resolves.toEqual({ id: "e1", number: "EST-7" });

    expect(http.requests[0].method).toBe("POST");
    expect(sentBody(http.requests[0].body)).toMatchObject({
      contact_id: "c1",
      currency: "EUR",
      tax_included: true,
      language: "ca",
      number_line_id: "series-e",
      payment_method_id: "pm1",
      items: [
        {
          name: "Pensió completa",
          service_id: "svc1",
          units: 60,
          price: 30.91,
          discount: 0,
          taxes: ["s_iva_10"],
          account: "ch1",
        },
      ],
    });
    // The create answers with the identifier alone; the number needs a read.
    expect(http.requests[1].logicalUrl).toBe(`${HOLDED_BASE_URL}/estimates/e1`);
  });

  it("sends an untaxed line as an empty list rather than omitting the key", async () => {
    const { http, client } = holded([page({ id: "e1" }), page({ id: "e1" })]);

    await client.createEstimate({
      contactId: "c1",
      description: "Stay",
      notes: "",
      language: "es",
      items: [{ description: "Deposit", units: 1, price: 200 }],
    });

    expect(sentBody(http.requests[0].body)).toMatchObject({
      items: [{ taxes: [], discount: 0 }],
    });
  });

  it("reports no number when the document cannot be read back", async () => {
    const { client } = holded([page({ id: "e1" }), page({ unreadable: true })]);

    await expect(
      client.createEstimate({
        contactId: "c1",
        description: "Stay",
        notes: "",
        language: "en",
        items: [],
      }),
    ).resolves.toEqual({ id: "e1", number: null });
  });

  it("refuses a create that answers without an identifier", async () => {
    const { client } = holded([page({ created: true })]);

    await expect(
      codeOf(
        client.createEstimate({
          contactId: "c1",
          description: "Stay",
          notes: "",
          language: "en",
          items: [],
        }),
      ),
    ).resolves.toBe("malformed_response");
  });

  it("creates an invoice with the date the advance falls due", async () => {
    const { http, client } = holded([
      page({ id: "i1" }),
      page({ id: "i1", document_number: "FAC-3" }),
    ]);

    await expect(
      client.createInvoice({
        contactId: "c1",
        description: "Advance",
        notes: "",
        language: "ca",
        dueDate: new Date("2026-07-15T22:00:00.000Z"),
        items: [{ description: "Advance", units: 1, price: 100 }],
      }),
    ).resolves.toEqual({ id: "i1", number: "FAC-3" });

    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/invoices`);
    expect(sentBody(http.requests[0].body)).toMatchObject({ due_date: "2026-07-15" });
  });

  it.each([
    ["approveEstimate" as const, "e1", "/estimates/e1/approve"],
    ["approveInvoice" as const, "i1", "/invoices/i1/approve"],
  ])("takes a document out of draft with %s", async (method, id, path) => {
    const { http, client } = holded([page({})]);

    await client[method](id);

    expect(http.requests[0].method).toBe("POST");
    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}${path}`);
  });

  it("sends an estimate through the configured template", async () => {
    const { http, client } = holded([page({})]);

    await client.sendEstimate("e1", ["hola@example.test"], "tpl-1");

    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/estimates/e1/send`);
    expect(sentBody(http.requests[0].body)).toEqual({
      emails: ["hola@example.test"],
      mail_template_id: "tpl-1",
    });
  });

  // There is no line patch: sending `items` replaces the whole collection.
  it("replaces every estimate line in one write", async () => {
    const { http, client } = holded([page({})]);

    await client.replaceEstimateLines("e1", [
      { description: "Balance", units: 1, price: 261.82 },
    ]);

    expect(http.requests[0].method).toBe("PUT");
    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/estimates/e1`);
    expect(sentBody(http.requests[0].body)).toMatchObject({
      tax_included: true,
      items: [{ description: "Balance", units: 1, price: 261.82 }],
    });
  });
});
