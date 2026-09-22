// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import { db } from "@/lib/db";
import {
  HoldedCreationError,
  HoldedDeliveryError,
  HoldedError,
  type HoldedInvoiceSummary,
} from "@/lib/holded/client";
import type { OutboxJob } from "@/modules/booking/services/outbox";
import {
  enqueueReserveInvoice,
  isCompatibleReserveInvoice,
  reserveInvoiceJobKey,
  runReserveInvoiceJob,
  type ReserveInvoiceClient,
} from "@/modules/booking/services/reserve-invoice";
import type { HoldedConfig } from "@/modules/booking/services/settings";
import { createBankingFixtureScope } from "../helpers/banking";

const config: HoldedConfig = {
  advanceServiceId: "svc-advance",
  depositServiceId: "svc-deposit",
  paymentMethodId: "payment-method-1",
  language: "ca",
  serviceIdsBySku: {},
  negotiatedTaxIds: [],
};

function productionInvoice(): HoldedInvoiceSummary {
  return {
    id: "invoice-existing",
    number: "F-2026-3",
    date: "2026-01-19",
    dueDate: "2026-01-19",
    totalCents: 46_400,
    status: "completed",
    contactId: "contact-1",
    taxIncluded: false,
    items: [
      {
        name: "Reserva",
        description: "Bestreta",
        serviceId: null,
        accountId: "account-advance",
        units: 1,
        priceCents: 24_000,
        taxes: ["s_iva_10"],
      },
      {
        name: "Dipòsit",
        description: "Fiança retornable",
        serviceId: null,
        accountId: "account-deposit",
        units: 1,
        priceCents: 20_000,
        taxes: [],
      },
    ],
  };
}

const expectedProductionInvoice = {
  contactId: "contact-1",
  date: "2026-01-19",
  dueDate: "2026-01-19",
  totalCents: 46_400,
  advance: {
    serviceId: "svc-advance",
    accountId: "account-advance",
    amountCents: 26_400,
  },
  deposit: {
    serviceId: "svc-deposit",
    accountId: "account-deposit",
    amountCents: 20_000,
  },
};

describe("reserve invoice compatibility", () => {
  it("accepts Holded's equivalent tax-exclusive production representation", () => {
    expect(
      isCompatibleReserveInvoice(productionInvoice(), expectedProductionInvoice),
    ).toBe(true);
  });

  it.each([
    ["contact", (invoice: HoldedInvoiceSummary) => ({ ...invoice, contactId: "other" })],
    ["issue date", (invoice: HoldedInvoiceSummary) => ({ ...invoice, date: "2026-01-18" })],
    ["due date", (invoice: HoldedInvoiceSummary) => ({ ...invoice, dueDate: null })],
    [
      "account",
      (invoice: HoldedInvoiceSummary) => ({
        ...invoice,
        items: invoice.items.map((line, index) =>
          index === 0 ? { ...line, accountId: "other" } : line,
        ),
      }),
    ],
    [
      "explicit service",
      (invoice: HoldedInvoiceSummary) => ({
        ...invoice,
        items: invoice.items.map((line, index) =>
          index === 0 ? { ...line, serviceId: "other" } : line,
        ),
      }),
    ],
    [
      "amount",
      (invoice: HoldedInvoiceSummary) => ({
        ...invoice,
        items: invoice.items.map((line, index) =>
          index === 0 ? { ...line, priceCents: 23_999 } : line,
        ),
      }),
    ],
    [
      "tax",
      (invoice: HoldedInvoiceSummary) => ({
        ...invoice,
        items: invoice.items.map((line, index) =>
          index === 0 ? { ...line, taxes: ["s_iva_21"] } : line,
        ),
      }),
    ],
  ])("rejects a mismatched %s", (_field, change) => {
    expect(
      isCompatibleReserveInvoice(
        change(productionInvoice()),
        expectedProductionInvoice,
      ),
    ).toBe(false);
  });
});

describe.skipIf(!runIntegrationTests)("reserve invoice issuance", () => {
  const scopes = new Set<ReturnType<typeof createBankingFixtureScope>>();
  const jobKeys = new Set<string>();

  async function fixture(label: string) {
    const scope = createBankingFixtureScope(label);
    scopes.add(scope);
    const customerData = {
      ...scope.customer(),
      email: " Fiscal@Example.test ",
      holdedContactId: `contact-${scope.scopeId}`,
    };
    await db.customer.create({ data: customerData });
    const bookingData = scope.booking(customerData, {
      state: "CONFIRMED",
      advanceCents: 43_200,
      depositCents: 20_000,
    });
    const booking = await db.bookingRequest.create({
      data: { ...bookingData, billableUnits: 60 },
    });
    const accountData = scope.treasuryAccount({ active: false });
    await db.holdedTreasuryAccount.create({ data: accountData });
    const movement = await db.bankMovement.create({
      data: scope.movement(accountData, { amountMinor: BigInt(66_000) }),
    });
    const linkedAt = new Date("2026-09-17T14:30:00.000Z");
    const payment = await db.payment.create({
      data: {
        bookingRequestId: booking.id,
        amountCents: 66_000,
        receivedAt: movement.bookingDate,
        bankMovementId: movement.id,
        createdAt: linkedAt,
      },
    });
    await db.$transaction((transaction) =>
      enqueueReserveInvoice(
        { bookingRequestId: booking.id, paymentId: payment.id },
        transaction,
      ),
    );
    const idempotencyKey = reserveInvoiceJobKey(booking.id);
    jobKeys.add(idempotencyKey);
    const stored = await db.integrationJob.findUniqueOrThrow({
      where: { idempotencyKey },
    });
    const job: OutboxJob = {
      id: stored.id,
      kind: stored.kind,
      idempotencyKey: stored.idempotencyKey,
      payload: stored.payload,
      attempts: 1,
    };
    return { scope, booking, payment, linkedAt, job };
  }

  function compatibleInvoice(
    invoiceId: string,
    contactId: string,
  ): HoldedInvoiceSummary {
    return {
      id: invoiceId,
      number: "F-2026-3",
      date: "2026-09-17",
      dueDate: "2026-09-17",
      totalCents: 63_200,
      status: "approved",
      contactId,
      taxIncluded: true,
      items: [
        {
          name: "Reserva",
          description: "30% de l'import total del pressupost.",
          serviceId: "svc-advance",
          accountId: "account-svc-advance",
          units: 1,
          priceCents: 43_200,
          taxes: ["s_iva_10"],
        },
        {
          name: "Dipòsit",
          description: "Fiança retornable",
          serviceId: "svc-deposit",
          accountId: "account-svc-deposit",
          units: 1,
          priceCents: 20_000,
          taxes: ["s_iva_nosujeto"],
        },
      ],
    };
  }

  function holded(overrides: Partial<ReserveInvoiceClient> = {}) {
    const client: ReserveInvoiceClient = {
      readService: vi.fn(async (serviceId) => ({
        priceCents: 1,
        accountId: `account-${serviceId}`,
      })),
      listNumberingSeries: vi.fn(async () => [{ id: "series-f", name: "F" }]),
      createInvoice: vi.fn(async () => ({ id: "invoice-new", number: "F-2026-3" })),
      getInvoice: vi.fn(async () => null),
      approveInvoice: vi.fn(async () => undefined),
      listDelegateEmails: vi.fn(async () => [
        "delegate@example.test",
        "fiscal@example.test",
      ]),
      sendEstimate: vi.fn(async () => undefined),
      sendInvoice: vi.fn(async () => undefined),
      ...overrides,
    };
    return client;
  }

  afterEach(async () => {
    await db.integrationJob.deleteMany({
      where: { idempotencyKey: { in: [...jobKeys] } },
    });
    jobKeys.clear();
    await Promise.all(
      [...scopes].map(async (scope) => {
        await scope.cleanup();
        scopes.delete(scope);
      }),
    );
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("creates, approves, and sends the agreed two-line invoice", async () => {
    const { booking, linkedAt, job } = await fixture("reserve-invoice-create");
    const client = holded();

    await runReserveInvoiceJob(job, { client, config });

    expect(client.readService).toHaveBeenCalledWith("svc-advance", { fresh: true });
    expect(client.readService).toHaveBeenCalledWith("svc-deposit", { fresh: true });

    expect(client.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: expect.stringContaining("contact-reserve-invoice-create"),
        date: linkedAt,
        dueDate: linkedAt,
        numberingSeriesId: "series-f",
        items: [
          expect.objectContaining({
            name: "Reserva",
            serviceId: "svc-advance",
            accountId: "account-svc-advance",
            price: 432,
            taxes: ["s_iva_10"],
          }),
          expect.objectContaining({
            name: "Dipòsit",
            serviceId: "svc-deposit",
            accountId: "account-svc-deposit",
            price: 200,
            taxes: ["s_iva_nosujeto"],
          }),
        ],
      }),
    );
    expect(client.approveInvoice).toHaveBeenCalledWith("invoice-new");
    expect(client.sendInvoice).toHaveBeenCalledWith(
      "invoice-new",
      {
        emails: ["fiscal@example.test"],
        cc: ["delegate@example.test"],
      },
      undefined,
      "Gestió de reserves Berea",
    );
    const document = await db.holdedDocument.findUniqueOrThrow({
      where: {
        bookingRequestId_type: {
          bookingRequestId: booking.id,
          type: "RESERVE_INVOICE",
        },
      },
    });
    expect(document).toMatchObject({
      holdedId: "invoice-new",
      documentNumber: "F-2026-3",
      totalCents: 63_200,
      sentAt: expect.any(Date),
    });
    await expect(
      db.documentIssuance.findUniqueOrThrow({
        where: {
          bookingRequestId_type: {
            bookingRequestId: booking.id,
            type: "RESERVE_INVOICE",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "ISSUED",
      holdedDocumentId: document.id,
      issuedAt: expect.any(Date),
    });
    await expect(
      db.documentDelivery.findUniqueOrThrow({
        where: { holdedDocumentId: document.id },
      }),
    ).resolves.toMatchObject({
      status: "ACCEPTED",
      toEmail: "fiscal@example.test",
      ccEmails: ["delegate@example.test"],
    });
  });

  it("keeps an agreed zero-valued component as an invoice line", async () => {
    const { booking, job } = await fixture("reserve-invoice-zero-component");
    await db.bookingRequest.update({
      where: { id: booking.id },
      data: { depositCents: 0 },
    });
    const client = holded();

    await runReserveInvoiceJob(job, { client, config });

    expect(client.createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ serviceId: "svc-deposit", price: 0 }),
        ]),
      }),
    );
  });

  it("reuses a compatible existing invoice without creating another", async () => {
    const { booking, job } = await fixture("reserve-invoice-reuse");
    const existing = await db.holdedDocument.create({
      data: {
        bookingRequestId: booking.id,
        type: "RESERVE_INVOICE",
        holdedId: "invoice-existing",
        documentNumber: "F-2026-3",
        totalCents: 63_200,
      },
    });
    const contact = await db.customer.findUniqueOrThrow({
      where: { id: booking.customerId },
    });
    const client = holded({
      getInvoice: vi.fn(async () =>
        compatibleInvoice("invoice-existing", contact.holdedContactId!),
      ),
    });

    await runReserveInvoiceJob(job, { client, config });

    expect(client.createInvoice).not.toHaveBeenCalled();
    expect(client.approveInvoice).not.toHaveBeenCalled();
    expect(client.sendInvoice).toHaveBeenCalledTimes(1);
    await expect(
      db.documentIssuance.findUniqueOrThrow({
        where: {
          bookingRequestId_type: {
            bookingRequestId: booking.id,
            type: "RESERVE_INVOICE",
          },
        },
      }),
    ).resolves.toMatchObject({ status: "ISSUED", holdedDocumentId: existing.id });
  });

  it("reuses a completed invoice after Holded normalizes its lines", async () => {
    const { booking, job } = await fixture("reserve-invoice-completed");
    await db.holdedDocument.create({
      data: {
        bookingRequestId: booking.id,
        type: "RESERVE_INVOICE",
        holdedId: "invoice-completed",
        documentNumber: "F-2026-3",
        totalCents: 63_200,
      },
    });
    const contact = await db.customer.findUniqueOrThrow({
      where: { id: booking.customerId },
    });
    const invoice = compatibleInvoice(
      "invoice-completed",
      contact.holdedContactId!,
    );
    invoice.status = "completed";
    invoice.taxIncluded = false;
    invoice.items = [
      { ...invoice.items[0]!, serviceId: null, priceCents: 39_273 },
      { ...invoice.items[1]!, serviceId: null, taxes: [] },
    ];
    const client = holded({ getInvoice: vi.fn(async () => invoice) });

    await runReserveInvoiceJob(job, { client, config });

    expect(client.createInvoice).not.toHaveBeenCalled();
    expect(client.approveInvoice).not.toHaveBeenCalled();
    expect(client.sendInvoice).toHaveBeenCalledTimes(1);
  });

  it("retries approval from the known invoice without creating another", async () => {
    const { booking, job } = await fixture("reserve-invoice-approval-retry");
    const first = holded({
      approveInvoice: vi.fn(async () => {
        throw new HoldedError("unavailable", "temporary approval failure");
      }),
    });

    await expect(runReserveInvoiceJob(job, { client: first, config })).rejects.toThrow(
      "temporary approval failure",
    );
    expect(first.createInvoice).toHaveBeenCalledTimes(1);
    await expect(
      db.holdedDocument.count({
        where: { bookingRequestId: booking.id, type: "RESERVE_INVOICE" },
      }),
    ).resolves.toBe(1);

    const contact = await db.customer.findUniqueOrThrow({
      where: { id: booking.customerId },
    });
    const pending = compatibleInvoice("invoice-new", contact.holdedContactId!);
    pending.status = "draft";
    const retry = holded({ getInvoice: vi.fn(async () => pending) });

    await runReserveInvoiceJob(job, { client: retry, config });

    expect(retry.createInvoice).not.toHaveBeenCalled();
    expect(retry.approveInvoice).toHaveBeenCalledWith("invoice-new");
    expect(retry.sendInvoice).toHaveBeenCalledTimes(1);
    await expect(
      db.holdedDocument.count({
        where: { bookingRequestId: booking.id, type: "RESERVE_INVOICE" },
      }),
    ).resolves.toBe(1);
  });

  it("blocks an existing invoice that omits the deposit", async () => {
    const { booking, job } = await fixture("reserve-invoice-block");
    await db.holdedDocument.create({
      data: {
        bookingRequestId: booking.id,
        type: "RESERVE_INVOICE",
        holdedId: "invoice-old",
        documentNumber: "F-OLD",
        totalCents: 43_200,
      },
    });
    const contact = await db.customer.findUniqueOrThrow({
      where: { id: booking.customerId },
    });
    const incompatible = compatibleInvoice(
      "invoice-old",
      contact.holdedContactId!,
    );
    incompatible.totalCents = 43_200;
    incompatible.items = [incompatible.items[0]!];
    const client = holded({ getInvoice: vi.fn(async () => incompatible) });

    await runReserveInvoiceJob(job, { client, config });

    expect(client.createInvoice).not.toHaveBeenCalled();
    expect(client.sendInvoice).not.toHaveBeenCalled();
    await expect(
      db.documentIssuance.findUniqueOrThrow({
        where: {
          bookingRequestId_type: {
            bookingRequestId: booking.id,
            type: "RESERVE_INVOICE",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "BLOCKED",
      lastFailureCode: "incompatible_existing_invoice",
      blockedAt: expect.any(Date),
    });
  });

  it("parks an uncertain create and never creates again automatically", async () => {
    const { booking, job } = await fixture("reserve-invoice-unknown");
    const client = holded({
      createInvoice: vi.fn(async () => {
        throw new HoldedError("unavailable", "timeout");
      }),
    });

    await runReserveInvoiceJob(job, { client, config });
    await runReserveInvoiceJob(job, { client, config });

    expect(client.createInvoice).toHaveBeenCalledTimes(1);
    await expect(
      db.documentIssuance.findUniqueOrThrow({
        where: {
          bookingRequestId_type: {
            bookingRequestId: booking.id,
            type: "RESERVE_INVOICE",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "UNKNOWN",
      lastFailureCode: "unavailable",
      outcomeUnknownAt: expect.any(Date),
    });
    await expect(
      db.holdedDocument.count({ where: { bookingRequestId: booking.id } }),
    ).resolves.toBe(0);
  });

  it("parks an uncertain delivery and never sends it automatically again", async () => {
    const { booking, job } = await fixture("reserve-invoice-delivery-unknown");
    const first = holded({
      sendInvoice: vi.fn(async () => {
        throw new HoldedDeliveryError("unavailable", "unknown", "timeout");
      }),
    });

    await expect(runReserveInvoiceJob(job, { client: first, config })).rejects.toThrow(
      "timeout",
    );

    const retry = holded();
    await runReserveInvoiceJob(job, { client: retry, config });

    expect(first.sendInvoice).toHaveBeenCalledTimes(1);
    expect(retry.createInvoice).not.toHaveBeenCalled();
    expect(retry.sendInvoice).not.toHaveBeenCalled();
    const document = await db.holdedDocument.findUniqueOrThrow({
      where: {
        bookingRequestId_type: {
          bookingRequestId: booking.id,
          type: "RESERVE_INVOICE",
        },
      },
    });
    await expect(
      db.documentDelivery.findUniqueOrThrow({
        where: { holdedDocumentId: document.id },
      }),
    ).resolves.toMatchObject({
      status: "UNKNOWN",
      outcomeUnknownAt: expect.any(Date),
    });
  });

  it("retries an explicit create refusal without duplicating a document", async () => {
    const { booking, job } = await fixture("reserve-invoice-retry");
    const refused = holded({
      createInvoice: vi.fn(async () => {
        throw new HoldedCreationError(
          "invalid_request",
          "definitive_failure",
          "rejected",
        );
      }),
    });

    await expect(
      runReserveInvoiceJob(job, { client: refused, config }),
    ).rejects.toThrow("rejected");
    await expect(
      db.documentIssuance.findUniqueOrThrow({
        where: {
          bookingRequestId_type: {
            bookingRequestId: booking.id,
            type: "RESERVE_INVOICE",
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "FAILED",
      lastFailureCode: "invalid_request",
    });

    const retry = holded();
    await runReserveInvoiceJob(job, { client: retry, config });

    expect(retry.createInvoice).toHaveBeenCalledTimes(1);
    await expect(
      db.holdedDocument.count({
        where: { bookingRequestId: booking.id, type: "RESERVE_INVOICE" },
      }),
    ).resolves.toBe(1);
  });

  it("retries a numbering-series read that failed before creation", async () => {
    const { booking, job } = await fixture("reserve-invoice-series-retry");
    const unavailable = holded({
      listNumberingSeries: vi.fn(async () => {
        throw new HoldedError("unavailable", "temporary outage");
      }),
    });

    await expect(
      runReserveInvoiceJob(job, { client: unavailable, config }),
    ).rejects.toThrow("temporary outage");
    await expect(
      db.documentIssuance.findUniqueOrThrow({
        where: {
          bookingRequestId_type: {
            bookingRequestId: booking.id,
            type: "RESERVE_INVOICE",
          },
        },
      }),
    ).resolves.toMatchObject({ status: "PREPARED" });

    const retry = holded();
    await runReserveInvoiceJob(job, { client: retry, config });

    expect(retry.createInvoice).toHaveBeenCalledTimes(1);
    await expect(
      db.documentIssuance.findUniqueOrThrow({
        where: {
          bookingRequestId_type: {
            bookingRequestId: booking.id,
            type: "RESERVE_INVOICE",
          },
        },
      }),
    ).resolves.toMatchObject({ status: "ISSUED" });
  });

  it("allows concurrent workers to create and deliver only once", async () => {
    const { booking, job } = await fixture("reserve-invoice-concurrent");
    let seriesReads = 0;
    let releaseSeries!: () => void;
    const bothWorkersReady = new Promise<void>((resolve) => {
      releaseSeries = resolve;
    });
    const client = holded({
      listNumberingSeries: vi.fn(async () => {
        seriesReads += 1;
        if (seriesReads === 2) releaseSeries();
        await bothWorkersReady;
        return [{ id: "series-f", name: "F" }];
      }),
    });

    await Promise.all([
      runReserveInvoiceJob(job, { client, config }),
      runReserveInvoiceJob(job, { client, config }),
    ]);

    expect(client.createInvoice).toHaveBeenCalledTimes(1);
    expect(client.approveInvoice).toHaveBeenCalledTimes(1);
    expect(client.sendInvoice).toHaveBeenCalledTimes(1);
    await expect(
      db.holdedDocument.count({
        where: { bookingRequestId: booking.id, type: "RESERVE_INVOICE" },
      }),
    ).resolves.toBe(1);
    await expect(
      db.documentDelivery.count({
        where: { holdedDocument: { bookingRequestId: booking.id } },
      }),
    ).resolves.toBe(1);
  });
});