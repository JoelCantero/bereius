// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import { db } from "@/lib/db";
import type { HoldedClient } from "@/lib/holded/client";
import type { HoldedConfig } from "@/modules/booking/services/settings";
import type { OutboxJob } from "@/modules/booking/services/outbox";
import { runQuoteJob } from "@/modules/booking/services/quoting";

const config: HoldedConfig = {
  accountingAccountId: "acct-1",
  depositServiceId: "svc-deposit",
  mailTemplateId: "tpl-1",
  paymentMethodId: "pay-1",
  language: "ca",
  serviceIdsBySku: { dc40: "svc-dc40", pc40: "svc-pc40" },
};

interface StubOptions {
  failOn?: keyof HoldedClient;
}

function stubClient(options: StubOptions = {}) {
  const calls: string[] = [];

  const track = <T>(name: keyof HoldedClient, value: () => T) => {
    calls.push(name);
    if (options.failOn === name) {
      throw new Error(`Holded failed at ${name}`);
    }
    return value();
  };

  const client: HoldedClient = {
    ping: vi.fn(async () => {
      track("ping", () => undefined);
    }),
    findContactByTaxId: vi.fn(async () => track("findContactByTaxId", () => null)),
    createContact: vi.fn(async () => track("createContact", () => ({ id: "contact-1" }))),
    updateContactEmail: vi.fn(async () => {
      track("updateContactEmail", () => undefined);
    }),
    getServicePriceCents: vi.fn(async () => track("getServicePriceCents", () => 1_800)),
    createEstimate: vi.fn(async () =>
      track("createEstimate", () => ({ id: `est-${calls.length}`, number: "PRE-1" })),
    ),
    sendEstimate: vi.fn(async () => {
      track("sendEstimate", () => undefined);
    }),
    createInvoiceFromEstimate: vi.fn(async () =>
      track("createInvoiceFromEstimate", () => ({ id: `inv-${calls.length}`, number: "FAC-1" })),
    ),
    replaceEstimateLines: vi.fn(async () => {
      track("replaceEstimateLines", () => undefined);
    }),
  };

  return { client, calls };
}

describe.skipIf(!runIntegrationTests)("booking quoting integration", () => {
  const customerIds: string[] = [];

  async function approvedBooking() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customer = await db.customer.create({
      data: {
        taxId: `Q${suffix}`.slice(0, 20),
        name: "Fixture group",
        email: "group@example.test",
      },
    });
    customerIds.push(customer.id);

    return db.bookingRequest.create({
      data: {
        gravityEntryId: `quote-${suffix}`,
        customerId: customer.id,
        state: "APPROVED",
        boardType: "SELF_CATERING",
        startDate: new Date("2027-06-01T00:00:00.000Z"),
        endDate: new Date("2027-06-03T00:00:00.000Z"),
        headcount: 40,
        submittedAt: new Date(),
      },
    });
  }

  function job(bookingRequestId: string): OutboxJob {
    return {
      id: "job-1",
      kind: "booking.quote",
      idempotencyKey: `booking.quote:${bookingRequestId}`,
      payload: { bookingRequestId },
      attempts: 1,
    };
  }

  afterEach(async () => {
    await db.bookingRequest.deleteMany({ where: { customerId: { in: customerIds } } });
    await db.customer.deleteMany({ where: { id: { in: customerIds } } });
    customerIds.length = 0;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("issues the contact, estimate and reserve invoice, and records both documents", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    const documents = await db.holdedDocument.findMany({
      where: { bookingRequestId: booking.id },
      orderBy: { type: "asc" },
    });

    expect(documents.map((doc) => doc.type)).toEqual(["ESTIMATE", "RESERVE_INVOICE"]);
    expect(client.sendEstimate).toHaveBeenCalledTimes(1);
    expect(client.replaceEstimateLines).toHaveBeenCalledTimes(1);

    const updated = await db.bookingRequest.findUniqueOrThrow({ where: { id: booking.id } });
    // 2 nights x 40 people at 18 EUR, 30% advance plus the 200 EUR deposit.
    expect(updated.billableUnits).toBe(80);
    expect(updated.advanceCents).toBe(43_200);
    expect(updated.depositCents).toBe(20_000);
    expect(updated.paymentDueAt).not.toBeNull();
  });

  it("does not duplicate the estimate when the invoice step fails and the job retries", async () => {
    const booking = await approvedBooking();

    const failing = stubClient({ failOn: "createInvoiceFromEstimate" });
    await expect(runQuoteJob(job(booking.id), { client: failing.client, config })).rejects.toThrow();

    const afterFailure = await db.holdedDocument.findMany({
      where: { bookingRequestId: booking.id },
    });
    expect(afterFailure.map((doc) => doc.type)).toEqual(["ESTIMATE"]);

    const retry = stubClient();
    await runQuoteJob(job(booking.id), { client: retry.client, config });

    const documents = await db.holdedDocument.findMany({
      where: { bookingRequestId: booking.id },
    });
    expect(documents.filter((doc) => doc.type === "ESTIMATE")).toHaveLength(1);
    expect(documents.filter((doc) => doc.type === "RESERVE_INVOICE")).toHaveLength(1);
    // The retry resumed rather than re-issuing the estimate.
    expect(retry.client.createEstimate).not.toHaveBeenCalled();
    expect(retry.client.sendEstimate).not.toHaveBeenCalled();
  });

  it("reuses a stored Holded contact instead of looking it up again", async () => {
    const booking = await approvedBooking();
    await db.customer.update({
      where: { id: booking.customerId },
      data: { holdedContactId: "contact-existing" },
    });

    const { client } = stubClient();
    await runQuoteJob(job(booking.id), { client, config });

    expect(client.findContactByTaxId).not.toHaveBeenCalled();
    expect(client.createContact).not.toHaveBeenCalled();
  });

  it("records no document when the estimate call itself fails", async () => {
    const booking = await approvedBooking();
    const { client } = stubClient({ failOn: "createEstimate" });

    await expect(runQuoteJob(job(booking.id), { client, config })).rejects.toThrow();

    await expect(
      db.holdedDocument.count({ where: { bookingRequestId: booking.id } }),
    ).resolves.toBe(0);
  });

  it("refuses to quote a booking that is not approved", async () => {
    const booking = await approvedBooking();
    await db.bookingRequest.update({
      where: { id: booking.id },
      data: { state: "RECEIVED" },
    });
    const { client } = stubClient();

    await expect(
      runQuoteJob(job(booking.id), { client, config }),
    ).rejects.toMatchObject({ code: "wrong_state" });
    expect(client.createEstimate).not.toHaveBeenCalled();
  });

  it("fails loudly when no service is configured for the band", async () => {
    const booking = await approvedBooking();
    await db.bookingRequest.update({
      where: { id: booking.id },
      data: { headcount: 90 },
    });
    const { client } = stubClient();

    await expect(
      runQuoteJob(job(booking.id), { client, config }),
    ).rejects.toMatchObject({ code: "no_service" });
  });

  it("prefers a negotiated service over the band rate", async () => {
    const booking = await approvedBooking();
    await db.customer.update({
      where: { id: booking.customerId },
      data: { negotiatedServiceId: "svc-negotiated" },
    });
    const { client } = stubClient();

    await runQuoteJob(job(booking.id), { client, config });

    expect(client.getServicePriceCents).toHaveBeenCalledWith("svc-negotiated");
  });
});
