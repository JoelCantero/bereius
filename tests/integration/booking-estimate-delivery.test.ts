// @vitest-environment node

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import { db } from "@/lib/db";
import {
  HoldedDeliveryError,
  type HoldedClient,
} from "@/lib/holded/client";
import {
  deliverPreparedEstimate,
  prepareEstimateDelivery,
} from "@/modules/booking/services/estimate-delivery";

describe.skipIf(!runIntegrationTests)("estimate delivery persistence", () => {
  const customerIds: string[] = [];

  async function fixture() {
    const suffix = randomUUID();
    const customer = await db.customer.create({
      data: {
        taxId: `D${suffix}`,
        name: "Delivery fixture",
        email: " Fiscal@Example.test ",
        holdedContactId: `contact-${suffix}`,
      },
    });
    customerIds.push(customer.id);
    const booking = await db.bookingRequest.create({
      data: {
        gravityEntryId: `delivery-${suffix}`,
        customerId: customer.id,
        state: "AWAITING_PAYMENT",
        boardType: "SELF_CATERING",
        startDate: new Date("2027-06-01T00:00:00.000Z"),
        endDate: new Date("2027-06-03T00:00:00.000Z"),
        headcount: 40,
        submittedAt: new Date(),
      },
    });
    const document = await db.holdedDocument.create({
      data: {
        bookingRequestId: booking.id,
        type: "ESTIMATE",
        holdedId: `estimate-${suffix}`,
      },
    });
    return { customer, booking, document };
  }

  function holdedDelegates(emails: string[] = []) {
    return {
      listDelegateEmails: vi.fn(async () => emails),
    };
  }

  function holdedSender(
    implementation: HoldedClient["sendEstimate"] = vi.fn(async () => undefined),
  ) {
    return { sendEstimate: vi.fn(implementation) };
  }

  afterEach(async () => {
    await db.bookingRequest.deleteMany({ where: { customerId: { in: customerIds } } });
    await db.customer.deleteMany({ where: { id: { in: customerIds } } });
    customerIds.length = 0;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("reads Holded and freezes exact primary and CC recipients once", async () => {
    const { document } = await fixture();
    const holded = holdedDelegates([
      "Zulu@Example.test",
      "fiscal@example.test",
      "alpha@example.test",
    ]);

    const first = await prepareEstimateDelivery(document.id, holded);
    const second = await prepareEstimateDelivery(document.id, holded);

    expect(first).toMatchObject({
      status: "PREPARED",
      toEmail: "fiscal@example.test",
      ccEmails: ["alpha@example.test", "zulu@example.test"],
    });
    expect(second).toEqual(first);
    expect(holded.listDelegateEmails).toHaveBeenCalledTimes(1);
    await expect(
      db.estimateDelivery.count({ where: { holdedDocumentId: document.id } }),
    ).resolves.toBe(1);
  });

  it("does not create a delivery when the Holded delegate lookup fails", async () => {
    const { document } = await fixture();
    const holded = {
      listDelegateEmails: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await expect(prepareEstimateDelivery(document.id, holded)).rejects.toThrow("offline");
    await expect(
      db.estimateDelivery.count({ where: { holdedDocumentId: document.id } }),
    ).resolves.toBe(0);
  });

  it("records acceptance and suppresses every later send", async () => {
    const { document } = await fixture();
    await prepareEstimateDelivery(document.id, holdedDelegates());
    const holded = holdedSender();

    await expect(
      deliverPreparedEstimate(document.id, holded, "template-1"),
    ).resolves.toBe("accepted");
    await expect(
      deliverPreparedEstimate(document.id, holded, "template-1"),
    ).resolves.toBe("accepted");

    expect(holded.sendEstimate).toHaveBeenCalledTimes(1);
    expect(holded.sendEstimate).toHaveBeenCalledWith(
      document.holdedId,
      { emails: ["fiscal@example.test"], cc: [] },
      "template-1",
    );
    await expect(
      db.estimateDelivery.findUniqueOrThrow({
        where: { holdedDocumentId: document.id },
      }),
    ).resolves.toMatchObject({ status: "ACCEPTED", acceptedAt: expect.any(Date) });
    await expect(
      db.holdedDocument.findUniqueOrThrow({ where: { id: document.id } }),
    ).resolves.toMatchObject({ sentAt: expect.any(Date) });
  });

  it("retries a definitive refusal with the same frozen recipients", async () => {
    const { document } = await fixture();
    await prepareEstimateDelivery(
      document.id,
      holdedDelegates(["delegate@example.test"]),
    );
    const refused = holdedSender(async () => {
      throw new HoldedDeliveryError(
        "invalid_request",
        "definitive_failure",
        "refused",
      );
    });

    await expect(deliverPreparedEstimate(document.id, refused)).rejects.toThrow();
    await expect(
      db.estimateDelivery.findUniqueOrThrow({
        where: { holdedDocumentId: document.id },
      }),
    ).resolves.toMatchObject({ status: "FAILED", lastFailureCode: "invalid_request" });

    const retry = holdedSender();
    await deliverPreparedEstimate(document.id, retry);

    expect(retry.sendEstimate).toHaveBeenCalledWith(
      document.holdedId,
      {
        emails: ["fiscal@example.test"],
        cc: ["delegate@example.test"],
      },
      undefined,
    );
  });

  it("parks an unknown outcome and never sends it automatically again", async () => {
    const { document } = await fixture();
    await prepareEstimateDelivery(document.id, holdedDelegates());
    const ambiguous = holdedSender(async () => {
      throw new HoldedDeliveryError("unavailable", "unknown", "timeout");
    });

    await expect(deliverPreparedEstimate(document.id, ambiguous)).rejects.toThrow();
    await expect(
      db.estimateDelivery.findUniqueOrThrow({
        where: { holdedDocumentId: document.id },
      }),
    ).resolves.toMatchObject({
      status: "UNKNOWN",
      outcomeUnknownAt: expect.any(Date),
    });

    const retry = holdedSender();
    await expect(deliverPreparedEstimate(document.id, retry)).resolves.toBe("unknown");
    expect(retry.sendEstimate).not.toHaveBeenCalled();
  });

  it("parks an interrupted in-flight attempt instead of resending it", async () => {
    const { document } = await fixture();
    await prepareEstimateDelivery(document.id, holdedDelegates());
    await db.estimateDelivery.update({
      where: { holdedDocumentId: document.id },
      data: { status: "IN_FLIGHT", attemptedAt: new Date() },
    });
    const retry = holdedSender();

    await expect(deliverPreparedEstimate(document.id, retry)).resolves.toBe("unknown");
    expect(retry.sendEstimate).not.toHaveBeenCalled();
    await expect(
      db.estimateDelivery.findUniqueOrThrow({
        where: { holdedDocumentId: document.id },
      }),
    ).resolves.toMatchObject({ status: "UNKNOWN" });
  });
});