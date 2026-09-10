// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

const mocks = vi.hoisted(() => ({
  estimates: [] as Record<string, unknown>[],
  estimate: null as Record<string, unknown> | null,
  contact: null as Record<string, unknown> | null,
}));

vi.mock("@/modules/booking/services/settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntegration: vi.fn(async () => ({ config: {}, secret: "key" })),
}));

vi.mock("@/lib/holded/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHoldedClient: () => ({
    listEstimates: async () => mocks.estimates,
    getEstimate: async () => mocks.estimate,
    getContact: async () => mocks.contact,
  }),
}));

import { db } from "@/lib/db";
import { listContracts, readContract } from "@/modules/booking/services/contracts";

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

/**
 * Unique per test: the development database already holds linked estimates, and
 * a fixed identifier would collide with one of them.
 */
function uniqueId(): string {
  return `est-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function estimate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    number: "E260385",
    description: "27/11/26 - 29/11/26",
    date: "2026-09-09",
    totalCents: 52_801,
    status: "pending",
    contactId: "contact-1",
    contactName: CUSTOMER.name,
    ...overrides,
  };
}

describe.skipIf(!runIntegrationTests)("holded contracts", () => {
  const customerIds: string[] = [];

  async function booking(state: "IN_REVIEW" | "CANCELLED" = "IN_REVIEW") {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const customer = await db.customer.create({
      data: { ...CUSTOMER, taxId: `K${suffix}`.slice(0, 20) },
    });
    customerIds.push(customer.id);

    const request = await db.bookingRequest.create({
      data: {
        gravityEntryId: `contract-${suffix}`,
        customerId: customer.id,
        state,
        boardType: "SELF_CATERING",
        startDate: new Date("2027-06-01T00:00:00.000Z"),
        endDate: new Date("2027-06-03T00:00:00.000Z"),
        headcount: 40,
        submittedAt: new Date(),
      },
    });

    return { request, taxId: customer.taxId };
  }

  afterEach(() => {
    mocks.estimates = [];
    mocks.estimate = null;
    mocks.contact = null;
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await db.bookingRequest.deleteMany({ where: { customerId: { in: customerIds } } });
    await db.customer.deleteMany({ where: { id: { in: customerIds } } });
    await db.$disconnect();
  });

  it("marks an estimate no request claims as unlinked", async () => {
    const id = uniqueId();
    mocks.estimates = [estimate(id)];

    const result = await listContracts();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.contracts.find((row) => row.id === id)?.link).toBeNull();
  });

  it("names the request an estimate belongs to", async () => {
    const { request } = await booking();
    const holdedId = `linked-${request.id}`;
    await db.holdedDocument.create({
      data: { bookingRequestId: request.id, type: "ESTIMATE", holdedId },
    });
    mocks.estimates = [estimate(holdedId)];

    const result = await listContracts();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.contracts.find((row) => row.id === holdedId)?.link).toMatchObject({
      bookingRequestId: request.id,
      customerName: CUSTOMER.name,
      state: "IN_REVIEW",
    });
  });

  it("offers the requests of the customer whose tax id matches the contact", async () => {
    const id = uniqueId();
    const { request, taxId } = await booking();
    mocks.estimate = estimate(id);
    mocks.contact = { id: "contact-1", taxId };

    const detail = await readContract(id);

    expect(detail.status).toBe("unlinked");
    if (detail.status !== "unlinked") return;
    expect(detail.taxId).toBe(taxId);
    expect(detail.candidates.map((candidate) => candidate.id)).toContain(request.id);
  });

  it("offers nothing when Holded holds no tax id for the contact", async () => {
    const id = uniqueId();
    await booking();
    mocks.estimate = estimate(id);
    mocks.contact = { id: "contact-1", taxId: null };

    const detail = await readContract(id);

    expect(detail).toMatchObject({ status: "unlinked", taxId: null, candidates: [] });
  });

  it("keeps a closed request out of the candidates", async () => {
    const id = uniqueId();
    const { taxId } = await booking("CANCELLED");
    mocks.estimate = estimate(id);
    mocks.contact = { id: "contact-1", taxId };

    const detail = await readContract(id);

    expect(detail.status).toBe("unlinked");
    if (detail.status !== "unlinked") return;
    expect(detail.candidates).toEqual([]);
  });

  it("keeps a request that already holds an estimate out of the candidates", async () => {
    const id = uniqueId();
    const { request, taxId } = await booking();
    await db.holdedDocument.create({
      data: {
        bookingRequestId: request.id,
        type: "ESTIMATE",
        holdedId: `other-${request.id}`,
      },
    });
    mocks.estimate = estimate(id);
    mocks.contact = { id: "contact-1", taxId };

    const detail = await readContract(id);

    expect(detail.status).toBe("unlinked");
    if (detail.status !== "unlinked") return;
    expect(detail.candidates).toEqual([]);
  });

  it("reports a linked estimate as linked rather than offering candidates", async () => {
    const { request } = await booking();
    const holdedId = `claimed-${request.id}`;
    await db.holdedDocument.create({
      data: { bookingRequestId: request.id, type: "ESTIMATE", holdedId },
    });
    mocks.estimate = estimate(holdedId);

    const detail = await readContract(holdedId);

    expect(detail).toMatchObject({
      status: "linked",
      link: { bookingRequestId: request.id, customerName: CUSTOMER.name },
    });
  });

  it("puts the request whose dates the description names first", async () => {
    const id = uniqueId();
    const { request, taxId } = await booking();
    // The stay the fixture books, in the shape the retired workflow wrote.
    mocks.estimate = estimate(id, { description: "01/06/27 - 03/06/27 - 40 persones DC" });
    mocks.contact = { id: "contact-1", taxId };

    const detail = await readContract(id);

    expect(detail.status).toBe("unlinked");
    if (detail.status !== "unlinked") return;
    expect(detail.candidates[0]).toMatchObject({ id: request.id, suggested: true });
  });

  it("suggests nothing when the description names other dates", async () => {
    const id = uniqueId();
    const { taxId } = await booking();
    mocks.estimate = estimate(id, { description: "09/09/99 - 10/09/99" });
    mocks.contact = { id: "contact-1", taxId };

    const detail = await readContract(id);

    expect(detail.status).toBe("unlinked");
    if (detail.status !== "unlinked") return;
    expect(detail.candidates.every((candidate) => !candidate.suggested)).toBe(true);
  });

  it("reports an estimate Holded no longer holds as missing", async () => {
    mocks.estimate = null;

    await expect(readContract("gone")).resolves.toEqual({ status: "missing" });
  });
});
