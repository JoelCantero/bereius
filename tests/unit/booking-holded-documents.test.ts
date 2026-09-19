// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createHoldedClient,
  HoldedCreationError,
  HoldedDeliveryError,
  HOLDED_BASE_URL,
} from "@/lib/holded/client";
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

  it("marks an explicit create refusal as definitive", async () => {
    const { client } = holded([status(422)]);

    try {
      await client.createInvoice({
        contactId: "c1",
        description: "Advance",
        notes: "",
        language: "ca",
        date: new Date("2026-07-15T00:00:00.000Z"),
        dueDate: new Date("2026-07-15T00:00:00.000Z"),
        items: [],
      });
      expect.unreachable("expected Holded to refuse the create");
    } catch (error) {
      expect(error).toBeInstanceOf(HoldedCreationError);
      expect(error).toMatchObject({
        code: "invalid_request",
        creationOutcome: "definitive_failure",
      });
    }
  });

  it("marks a network create failure as an unknown outcome", async () => {
    const { client } = holded([{ error: new Error("socket closed") }]);

    try {
      await client.createInvoice({
        contactId: "c1",
        description: "Advance",
        notes: "",
        language: "ca",
        date: new Date("2026-07-15T00:00:00.000Z"),
        dueDate: new Date("2026-07-15T00:00:00.000Z"),
        items: [],
      });
      expect.unreachable("expected Holded creation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HoldedCreationError);
      expect(error).toMatchObject({
        code: "unavailable",
        creationOutcome: "unknown",
      });
    }
  });

  it.each([408, 500])(
    "marks an ambiguous HTTP %i create failure as an unknown outcome",
    async (httpStatus) => {
      const { client } = holded([status(httpStatus)]);

      try {
        await client.createInvoice({
          contactId: "c1",
          description: "Advance",
          notes: "",
          language: "ca",
          date: new Date("2026-07-15T00:00:00.000Z"),
          dueDate: new Date("2026-07-15T00:00:00.000Z"),
          items: [],
        });
        expect.unreachable("expected Holded creation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(HoldedCreationError);
        expect(error).toMatchObject({
          code: "unavailable",
          creationOutcome: "unknown",
        });
      }
    },
  );

  it("marks an explicit create conflict as definitive", async () => {
    const { client } = holded([status(409)]);

    try {
      await client.createInvoice({
        contactId: "c1",
        description: "Advance",
        notes: "",
        language: "ca",
        date: new Date("2026-07-15T00:00:00.000Z"),
        dueDate: new Date("2026-07-15T00:00:00.000Z"),
        items: [],
      });
      expect.unreachable("expected Holded to refuse the create");
    } catch (error) {
      expect(error).toBeInstanceOf(HoldedCreationError);
      expect(error).toMatchObject({
        code: "invalid_request",
        creationOutcome: "definitive_failure",
      });
    }
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
        website: "",
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
    expect(sentBody(update.body)).not.toHaveProperty("custom_id");
    expect(sentBody(update.body)).not.toHaveProperty("website");
    expect(sentBody(update.body)).not.toHaveProperty("created_at");
    expect(sentBody(update.body)).not.toHaveProperty("rate");
  });

  it("refuses to update a record it could not read back", async () => {
    const { client } = holded([page({ no_id: true })]);

    await expect(
      codeOf(client.updateContact("c1", { name: "N", code: "G1", email: "n@example.test" })),
    ).resolves.toBe("malformed_response");
  });

  it("pages contacts and lists only delegates projected for the requested principal", async () => {
    const { http, client } = holded([
      page({
        items: [
          {
            id: "person-manual",
            name: "Manual contact",
            email: "manual@example.test",
            is_person: true,
          },
          {
            id: "person-other-principal",
            code: "berea-wp-delegate:principal-2:90:1",
            name: "Other principal delegate",
            email: "other@example.test",
            is_person: true,
          },
          {
            id: "person-zulu",
            code: "berea-wp-delegate:principal-1:91:1",
            name: "Zulu delegate",
            email: " Zulu@Example.test ",
            is_person: true,
          },
        ],
        has_more: true,
        cursor: "next-page",
      }),
      page({
        items: [
          {
            id: "person-alpha",
            code: "berea-wp-delegate:principal-1:92:4",
            name: "Alpha delegate",
            email: "alpha@example.test",
            is_person: true,
          },
          {
            id: "person-old-marker",
            code: "berea-wp-delegate:93:1",
            name: "Unmigrated delegate",
            email: "old@example.test",
            is_person: true,
          },
        ],
        has_more: false,
        cursor: null,
      }),
    ]);

    await expect(client.listDelegateEmails("principal-1")).resolves.toEqual([
      "alpha@example.test",
      "zulu@example.test",
    ]);
    expect(http.requests.map((request) => request.method)).toEqual(["GET", "GET"]);
    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/contacts?limit=100`);
    expect(http.requests[1].logicalUrl).toContain("cursor=next-page");
  });

  it("deduplicates delegate addresses and ignores malformed non-managed contacts", async () => {
    const { client } = holded([
      page({
        items: [
          {
            id: "person-1",
            code: "berea-wp-delegate:principal-1:91:1",
            name: "Delegate one",
            email: "delegate@example.test",
            is_person: true,
          },
          {
            id: "person-2",
            code: "berea-wp-delegate:principal-1:92:1",
            name: "Delegate two",
            email: "DELEGATE@example.test",
            is_person: true,
          },
          {
            id: "person-3",
            code: "other-system:93:1",
            name: "Other system",
            email: "not-an-email",
            is_person: true,
          },
        ],
        has_more: false,
      }),
    ]);

    await expect(client.listDelegateEmails("principal-1")).resolves.toEqual([
      "delegate@example.test",
    ]);
  });

  it.each([
    [
      "marker",
      {
        id: "person-1",
        code: "berea-wp-delegate:principal-1:not-a-user:1",
        email: "delegate@example.test",
        is_person: true,
      },
    ],
    [
      "email",
      {
        id: "person-1",
        code: "berea-wp-delegate:principal-1:91:1",
        email: "not-an-email",
        is_person: true,
      },
    ],
  ])("fails closed for a malformed managed delegate %s", async (_field, contact) => {
    const { client } = holded([
      page({ items: [contact], has_more: false }),
    ]);

    await expect(codeOf(client.listDelegateEmails("principal-1"))).resolves.toBe(
      "malformed_response",
    );
  });

  it("fails closed when a later contact page cannot be read", async () => {
    const { client } = holded([
      page({ items: [], has_more: true, cursor: "next-page" }),
      status(503),
    ]);

    await expect(codeOf(client.listDelegateEmails("principal-1"))).resolves.toBe(
      "unavailable",
    );
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

describe("Holded invoice reads", () => {
  it("reads the accounting fields needed to verify an existing invoice", async () => {
    const { http, client } = holded([
      page({
        id: "i1",
        document_number: "F-2026-3",
        date: "2026-09-17",
        due_date: "2026-09-17",
        total: "632,00",
        status: "approved",
        contact_id: "c1",
        tax_included: true,
        lines: [
          {
            name: "Reserva",
            description: "Bestreta",
            service_id: "svc-advance",
            units: 1,
            price: "432,00",
            taxes: ["s_iva_10"],
            account: "account-advance",
          },
          {
            name: "Dipòsit",
            description: "Fiança retornable",
            service_id: "svc-deposit",
            units: 1,
            price: 200,
            taxes: ["s_iva_nosujeto"],
            account: "account-deposit",
          },
        ],
      }),
    ]);

    await expect(client.getInvoice("i1")).resolves.toEqual({
      id: "i1",
      number: "F-2026-3",
      date: "2026-09-17",
      dueDate: "2026-09-17",
      totalCents: 63_200,
      status: "approved",
      contactId: "c1",
      taxIncluded: true,
      items: [
        {
          name: "Reserva",
          description: "Bestreta",
          serviceId: "svc-advance",
          accountId: "account-advance",
          units: 1,
          priceCents: 43_200,
          taxes: ["s_iva_10"],
        },
        {
          name: "Dipòsit",
          description: "Fiança retornable",
          serviceId: "svc-deposit",
          accountId: "account-deposit",
          units: 1,
          priceCents: 20_000,
          taxes: ["s_iva_nosujeto"],
        },
      ],
    });
    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/invoices/i1`);
  });

  it("preserves the tax-exclusive mode returned by production invoices", async () => {
    const { client } = holded([
      page({
        id: "i1",
        date: "2026-01-19",
        due_date: null,
        total: 464,
        status: "completed",
        contact_id: "c1",
        tax_included: false,
        lines: [
          {
            name: "Reserva",
            units: 1,
            price: 240,
            taxes: ["s_iva_10"],
            account: "account-advance",
          },
          {
            name: "Dipòsit",
            units: 1,
            price: 200,
            taxes: [],
            account: "account-deposit",
          },
        ],
      }),
    ]);

    await expect(client.getInvoice("i1")).resolves.toMatchObject({
      totalCents: 46_400,
      status: "completed",
      taxIncluded: false,
      items: [
        {
          serviceId: null,
          accountId: "account-advance",
          priceCents: 24_000,
          taxes: ["s_iva_10"],
        },
        {
          serviceId: null,
          accountId: "account-deposit",
          priceCents: 20_000,
          taxes: [],
        },
      ],
    });
  });

  it("reports an absent invoice as null", async () => {
    const { client } = holded([status(404)]);

    await expect(client.getInvoice("gone")).resolves.toBeNull();
  });

  it("refuses an invoice whose lines cannot be verified", async () => {
    const { client } = holded([page({ id: "i1", lines: [{ units: "many" }] })]);

    await expect(codeOf(client.getInvoice("i1"))).resolves.toBe(
      "malformed_response",
    );
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

  it("creates an invoice with explicit issue and due dates", async () => {
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
        date: new Date("2026-07-14T22:00:00.000Z"),
        dueDate: new Date("2026-07-15T22:00:00.000Z"),
        items: [{ description: "Advance", units: 1, price: 100 }],
      }),
    ).resolves.toEqual({ id: "i1", number: "FAC-3" });

    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/invoices`);
    expect(sentBody(http.requests[0].body)).toMatchObject({
      date: "2026-07-14",
      due_date: "2026-07-15",
    });
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

    await client.sendEstimate(
      "e1",
      {
        emails: ["fiscal@example.test"],
        cc: ["delegate@example.test", "other@example.test"],
      },
      "tpl-1",
    );

    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/estimates/e1/send`);
    expect(sentBody(http.requests[0].body)).toEqual({
      emails: ["fiscal@example.test"],
      cc: ["delegate@example.test", "other@example.test"],
      mail_template_id: "tpl-1",
    });
  });

  it("sends an invoice through the configured template", async () => {
    const { http, client } = holded([page({})]);

    await client.sendInvoice(
      "i1",
      {
        emails: ["fiscal@example.test"],
        cc: ["delegate@example.test"],
      },
      "tpl-1",
      "Gestión de reservas Berea",
    );

    expect(http.requests[0].logicalUrl).toBe(`${HOLDED_BASE_URL}/invoices/i1/send`);
    expect(sentBody(http.requests[0].body)).toEqual({
      emails: ["fiscal@example.test"],
      cc: ["delegate@example.test"],
      subject: "Gestión de reservas Berea",
      mail_template_id: "tpl-1",
    });
  });

  it("marks an explicit provider refusal as a definitive delivery failure", async () => {
    const { client } = holded([status(400)]);

    try {
      await client.sendEstimate(
        "e1",
        { emails: ["fiscal@example.test"], cc: [] },
      );
      expect.unreachable("expected Holded to refuse the send");
    } catch (error) {
      expect(error).toBeInstanceOf(HoldedDeliveryError);
      expect(error).toMatchObject({
        code: "invalid_request",
        deliveryOutcome: "definitive_failure",
      });
    }
  });

  it("marks a network failure as an unknown delivery outcome", async () => {
    const { client } = holded([{ error: new Error("socket closed") }]);

    try {
      await client.sendEstimate(
        "e1",
        { emails: ["fiscal@example.test"], cc: [] },
      );
      expect.unreachable("expected Holded delivery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HoldedDeliveryError);
      expect(error).toMatchObject({
        code: "unavailable",
        deliveryOutcome: "unknown",
      });
    }
  });

  it.each([408, 500])(
    "marks an ambiguous HTTP %i failure as an unknown delivery outcome",
    async (httpStatus) => {
      const { client } = holded([status(httpStatus)]);

      try {
        await client.sendEstimate(
          "e1",
          { emails: ["fiscal@example.test"], cc: [] },
        );
        expect.unreachable("expected Holded delivery to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(HoldedDeliveryError);
        expect(error).toMatchObject({
          code: "unavailable",
          deliveryOutcome: "unknown",
        });
      }
    },
  );

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
