// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import { db } from "@/lib/db";
import type { GravityFormsClient, GravityFormsEntry } from "@/lib/gravity-forms/client";
import { DEFAULT_GRAVITY_FORM_FIELDS as F } from "@/modules/booking/schema";
import { INTAKE_SOURCE, runIntake } from "@/modules/booking/services/intake";

function entry(overrides: Record<string, unknown> = {}): GravityFormsEntry {
  const suffix = Math.random().toString(36).slice(2, 10);
  return {
    id: `9${Date.now()}${Math.floor(Math.random() * 1000)}`,
    date_created: "2026-09-09 11:56:32",
    [F.firstName]: "Ana",
    [F.lastName]: "Exemple",
    [F.organisation]: "",
    [F.taxId]: ` x${suffix} `,
    [F.email]: "Group@Example.test",
    [F.phone]: "600000000",
    [F.addressLine]: "Carrer Example, 3",
    [F.city]: "Barcelona",
    [F.province]: "Barcelona",
    [F.postalCode]: "08014",
    [F.country]: "España",
    [F.headcount]: "40",
    [F.boardType]: "dc",
    [F.startDate]: "2027-11-19",
    [F.endDate]: "2027-11-21",
    // Client-computed fields the intake must ignore; these values are wrong,
    // exactly as the live form produces them.
    "47": "1",
    "39": "40",
    ...overrides,
  } as GravityFormsEntry;
}

function clientReturning(...batches: GravityFormsEntry[][]): GravityFormsClient {
  const queue = [...batches];
  return {
    fetchEntriesAfter: vi.fn(async () => queue.shift() ?? []),
  };
}

describe.skipIf(!runIntegrationTests)("booking intake integration", () => {
  const createdEntryIds: string[] = [];

  function track(entries: GravityFormsEntry[]) {
    createdEntryIds.push(...entries.map((item) => item.id));
    return entries;
  }

  afterEach(async () => {
    const bookings = await db.bookingRequest.findMany({
      where: { gravityEntryId: { in: createdEntryIds } },
      select: { customerId: true },
    });
    await db.bookingRequest.deleteMany({
      where: { gravityEntryId: { in: createdEntryIds } },
    });
    await db.customer.deleteMany({
      where: { id: { in: bookings.map((booking) => booking.customerId) } },
    });
    await db.intakeCursor.deleteMany({ where: { source: INTAKE_SOURCE } });
    createdEntryIds.length = 0;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("creates one booking per entry and advances the cursor", async () => {
    const entries = track([entry(), entry()]);

    await expect(
      runIntake({ client: clientReturning(entries) }),
    ).resolves.toMatchObject({
      read: 2,
      created: 2,
      skipped: 0,
      rejected: 0,
      cursor: entries[1]!.id,
    });

    await expect(
      db.bookingRequest.count({
        where: { gravityEntryId: { in: entries.map((item) => item.id) } },
      }),
    ).resolves.toBe(2);
  });

  it("stores the stay as submitted and ignores the form's computed fields", async () => {
    const [only] = track([entry()]);

    await runIntake({ client: clientReturning([only!]) });

    const booking = await db.bookingRequest.findUniqueOrThrow({
      where: { gravityEntryId: only!.id },
      include: { customer: true },
    });

    expect(booking).toMatchObject({
      boardType: "SELF_CATERING",
      headcount: 40,
      state: "IN_REVIEW",
    });
    expect(booking.startDate.toISOString()).toBe("2027-11-19T00:00:00.000Z");
    expect(booking.endDate.toISOString()).toBe("2027-11-21T00:00:00.000Z");
    // The entry claims one night and forty units; neither is persisted.
    expect(booking.billableUnits).toBeNull();
    expect(booking.customer.email).toBe("group@example.test");
    expect(booking.customer.taxId).toMatch(/^X[A-Z0-9]+$/u);
  });

  it("creates nothing on a second pass over the same entry", async () => {
    const entries = track([entry()]);

    await runIntake({ client: clientReturning(entries) });
    await expect(
      runIntake({ client: clientReturning(entries) }),
    ).resolves.toMatchObject({ read: 1, created: 0, skipped: 1 });

    await expect(
      db.bookingRequest.count({ where: { gravityEntryId: entries[0]!.id } }),
    ).resolves.toBe(1);
  });

  it("records a malformed entry and keeps importing the rest of the batch", async () => {
    const broken = entry({ [F.startDate]: "not-a-date" });
    const sound = entry();
    track([broken, sound]);

    await expect(
      runIntake({ client: clientReturning([broken, sound]) }),
    ).resolves.toMatchObject({ read: 2, created: 1, rejected: 1 });

    await expect(
      db.bookingRequest.count({ where: { gravityEntryId: broken.id } }),
    ).resolves.toBe(0);
    await expect(
      db.bookingRequest.count({ where: { gravityEntryId: sound.id } }),
    ).resolves.toBe(1);
  });

  it("leaves the cursor on the last committed entry when one fails", async () => {
    const first = entry();
    // An end date before the start date is refused after the schema passes.
    const failing = entry({ [F.startDate]: "2027-11-21", [F.endDate]: "2027-11-19" });
    track([first, failing]);

    await expect(
      runIntake({ client: clientReturning([first, failing]) }),
    ).rejects.toThrow();

    const cursor = await db.intakeCursor.findUnique({
      where: { source: INTAKE_SOURCE },
    });
    expect(cursor?.lastEntryId).toBe(first.id);
  });

  it("reuses the customer when the same tax identifier books again", async () => {
    const taxId = `X${Date.now()}`;
    const first = entry({ [F.taxId]: taxId });
    const second = entry({ [F.taxId]: taxId, [F.phone]: "611111111" });
    track([first, second]);

    await runIntake({ client: clientReturning([first, second]) });

    const customers = await db.customer.findMany({ where: { taxId } });
    expect(customers).toHaveLength(1);
    expect(customers[0]!.phone).toBe("611111111");
  });

  it("asks Gravity Forms only for entries after the stored cursor", async () => {
    const entries = track([entry()]);
    const client = clientReturning(entries, []);

    await runIntake({ client });
    await runIntake({ client });

    expect(client.fetchEntriesAfter).toHaveBeenNthCalledWith(1, null);
    expect(client.fetchEntriesAfter).toHaveBeenNthCalledWith(2, entries[0]!.id);
  });

  it("honours a remapped form, so a rebuilt form needs no code change", async () => {
    const remapped = { ...F, taxId: "901", headcount: "902" };
    const base = entry();
    const moved = {
      ...base,
      [F.taxId]: "",
      [F.headcount]: "",
      "901": `X${Date.now()}`,
      "902": "55",
    } as typeof base;
    track([moved]);

    await expect(
      runIntake({ client: clientReturning([moved]), fieldMap: remapped }),
    ).resolves.toMatchObject({ created: 1, rejected: 0 });

    await expect(
      db.bookingRequest.findUniqueOrThrow({
        where: { gravityEntryId: moved.id },
      }),
    ).resolves.toMatchObject({ headcount: 55 });
  });

  it("rejects the entry when the configured map points at absent fields", async () => {
    const only = entry();
    track([only]);

    await expect(
      runIntake({
        client: clientReturning([only]),
        fieldMap: { ...F, taxId: "999" },
      }),
    ).resolves.toMatchObject({ created: 0, rejected: 1 });
  });
});
