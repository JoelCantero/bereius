// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

const mocks = vi.hoisted(() => ({
  contact: null as Record<string, unknown> | null,
  estimates: [] as Record<string, unknown>[],
  updateContact: vi.fn(async () => undefined),
  createContact: vi.fn(async () => ({ id: "new-contact" })),
}));

vi.mock("@/modules/booking/services/settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntegration: vi.fn(async () => ({ config: {}, secret: "key" })),
}));

vi.mock("@/lib/holded/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHoldedClient: () => ({
    findContactByTaxId: async () => mocks.contact,
    listEstimatesByContact: async () => mocks.estimates,
    updateContact: mocks.updateContact,
    createContact: mocks.createContact,
  }),
}));

import { db } from "@/lib/db";
import {
  inspectCustomerContact,
  linkExistingEstimate,
  updateCustomerContact,
} from "@/modules/booking/services/contact-sync";

const CUSTOMER = {
  name: "Juventud para Cristo",
  email: "hola@example.test",
  phone: "654513598",
  addressLine: "Carrer Example 1",
  city: "Barcelona",
  province: "Barcelona",
  postalCode: "08014",
  country: "España",
};

/** Holded keeps the number under `mobile`, which the client folds into phone. */
const HOLDED_CONTACT = {
  id: "contact-1",
  name: CUSTOMER.name,
  taxId: "X1",
  email: CUSTOMER.email,
  phone: CUSTOMER.phone,
  addressLine: CUSTOMER.addressLine,
  city: CUSTOMER.city,
  province: CUSTOMER.province,
  postalCode: CUSTOMER.postalCode,
  country: CUSTOMER.country,
};

describe.skipIf(!runIntegrationTests)("holded contact synchronisation", () => {
  const customerIds: string[] = [];

  async function booking() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customer = await db.customer.create({
      data: { ...CUSTOMER, taxId: `C${suffix}`.slice(0, 20) },
    });
    customerIds.push(customer.id);

    return db.bookingRequest.create({
      data: {
        gravityEntryId: `contact-${suffix}`,
        customerId: customer.id,
        boardType: "SELF_CATERING",
        startDate: new Date("2027-06-01T00:00:00.000Z"),
        endDate: new Date("2027-06-03T00:00:00.000Z"),
        headcount: 40,
        submittedAt: new Date(),
      },
    });
  }

  afterEach(async () => {
    mocks.contact = null;
    mocks.estimates = [];
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await db.bookingRequest.deleteMany({ where: { customerId: { in: customerIds } } });
    await db.customer.deleteMany({ where: { id: { in: customerIds } } });
    await db.$disconnect();
  });

  it("reports a tax identifier Holded has never seen", async () => {
    const request = await booking();

    await expect(inspectCustomerContact(request.id)).resolves.toMatchObject({
      status: "missing",
    });
  });

  it("treats a contact whose details agree as a match", async () => {
    mocks.contact = HOLDED_CONTACT;
    const request = await booking();

    await expect(inspectCustomerContact(request.id)).resolves.toMatchObject({
      status: "matches",
      contactId: "contact-1",
      differences: [],
    });
  });

  it("names only the fields that actually differ", async () => {
    mocks.contact = {
      ...HOLDED_CONTACT,
      // Casing and padding are not differences worth an operator's attention.
      name: "  juventud PARA cristo ",
      addressLine: "c/Example 1",
      country: null,
    };
    const request = await booking();

    const result = await inspectCustomerContact(request.id);
    expect(result.status).toBe("differs");
    if (result.status !== "differs") return;

    expect(result.differences.map((difference) => difference.field)).toEqual([
      "addressLine",
      "country",
    ]);
    expect(result.differences[0]).toEqual({
      field: "addressLine",
      ours: "Carrer Example 1",
      theirs: "c/Example 1",
    });
  });

  it("sends the whole record when updating, so Holded cannot blank the rest", async () => {
    mocks.contact = { ...HOLDED_CONTACT, email: "old@example.test" };
    const request = await booking();

    await updateCustomerContact(request.id);

    expect(mocks.updateContact).toHaveBeenCalledWith(
      "contact-1",
      expect.objectContaining({
        email: CUSTOMER.email,
        name: CUSTOMER.name,
        address: CUSTOMER.addressLine,
        postalCode: CUSTOMER.postalCode,
      }),
    );
  });

  it("refuses to attach an estimate that belongs to somebody else", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1" }];
    const request = await booking();

    await expect(
      linkExistingEstimate(request.id, "estimate-of-another-customer"),
    ).rejects.toMatchObject({ code: "not_in_holded" });

    await expect(
      db.holdedDocument.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
  });

  it("records an estimate the contact really owns", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1" }];
    const request = await booking();

    await linkExistingEstimate(request.id, "estimate-1");

    await expect(
      db.holdedDocument.findFirst({ where: { bookingRequestId: request.id } }),
    ).resolves.toMatchObject({
      type: "ESTIMATE",
      holdedId: "estimate-1",
      documentNumber: "E1",
    });
  });

  it("approves the request, because the estimate is the contract", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1" }];
    const request = await booking();

    await linkExistingEstimate(request.id, "estimate-1");

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "APPROVED" });

    const events = await db.bookingAuditEvent.findMany({
      where: { bookingRequestId: request.id },
    });
    expect(events.map((event) => [event.fromState, event.toState])).toEqual([
      ["IN_REVIEW", "APPROVED"],
    ]);
  });

  it("leaves a request that has already moved on where it is", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1" }];
    const request = await booking();
    await db.bookingRequest.update({
      where: { id: request.id },
      data: { state: "CONFIRMED" },
    });

    await linkExistingEstimate(request.id, "estimate-1");

    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "CONFIRMED" });
  });

  it("attaches nothing when the approval cannot be recorded", async () => {
    mocks.contact = HOLDED_CONTACT;
    mocks.estimates = [{ id: "estimate-1", number: "E1" }];
    const request = await booking();

    // An actor that does not exist fails the audit row's foreign key, standing
    // in for any late failure once the document has already been written.
    await expect(
      linkExistingEstimate(request.id, "estimate-1", "missing-user-id"),
    ).rejects.toThrow();

    // Neither half may survive: a contract without its approval is the drift
    // this transaction exists to prevent.
    await expect(
      db.holdedDocument.count({ where: { bookingRequestId: request.id } }),
    ).resolves.toBe(0);
    await expect(
      db.bookingRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).resolves.toMatchObject({ state: "IN_REVIEW" });
  });
});
