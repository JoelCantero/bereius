import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Pool } from "pg";

import {
  cleanupAuthenticatedUsers,
  installAuthSessionCookie,
  seedAuthenticatedUser,
} from "./helpers/authenticated-user";

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for booking review E2E fixtures");
  }
  return new Pool({ connectionString });
}

const seededCustomerIds: string[] = [];

interface SeededBooking {
  id: string;
  customerName: string;
}

async function seedBookingRequest(): Promise<SeededBooking> {
  const pool = getPool();
  const suffix = randomUUID().slice(0, 8);
  const customerId = `cust_${randomUUID()}`;
  const bookingId = `book_${randomUUID()}`;
  const customerName = `Colla ${suffix}`;

  try {
    await pool.query(
      `INSERT INTO "Customer"
         ("id","taxId","name","email","phone","addressLine","city","province","postalCode","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
      [
        customerId,
        `E2E${suffix}`.toUpperCase(),
        customerName,
        `group-${suffix}@example.test`,
        "600000000",
        "Carrer Example, 3",
        "Barcelona",
        "Barcelona",
        "08014",
      ],
    );

    await pool.query(
      `INSERT INTO "BookingRequest"
         ("id","gravityEntryId","customerId","state","boardType","startDate","endDate",
          "headcount","submittedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,'IN_REVIEW','SELF_CATERING','2027-06-01','2027-06-03',40,NOW(),NOW(),NOW())`,
      [bookingId, `e2e-${suffix}`, customerId],
    );
  } finally {
    await pool.end();
  }

  seededCustomerIds.push(customerId);
  return { id: bookingId, customerName };
}

async function readBookingState(bookingId: string): Promise<string | undefined> {
  const pool = getPool();
  try {
    const result = await pool.query<{ state: string }>(
      `SELECT "state" FROM "BookingRequest" WHERE "id" = $1`,
      [bookingId],
    );
    return result.rows[0]?.state;
  } finally {
    await pool.end();
  }
}

async function readAuditTrail(bookingId: string) {
  const pool = getPool();
  try {
    const result = await pool.query<{
      toState: string;
      actorUserId: string | null;
      reason: string | null;
    }>(
      `SELECT "toState","actorUserId","reason" FROM "BookingAuditEvent"
       WHERE "bookingRequestId" = $1 ORDER BY "createdAt" ASC`,
      [bookingId],
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

async function countQueuedQuotes(bookingId: string): Promise<number> {
  const pool = getPool();
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "IntegrationJob" WHERE "idempotencyKey" = $1`,
      [`booking.quote:${bookingId}`],
    );
    return Number(result.rows[0]?.count ?? "0");
  } finally {
    await pool.end();
  }
}

test.afterEach(async () => {
  if (seededCustomerIds.length > 0) {
    const pool = getPool();
    try {
      await pool.query(
        `DELETE FROM "IntegrationJob" WHERE "idempotencyKey" IN (
           SELECT 'booking.quote:' || "id" FROM "BookingRequest" WHERE "customerId" = ANY($1)
         )`,
        [seededCustomerIds],
      );
      await pool.query(`DELETE FROM "BookingRequest" WHERE "customerId" = ANY($1)`, [
        seededCustomerIds,
      ]);
      await pool.query(`DELETE FROM "Customer" WHERE "id" = ANY($1)`, [seededCustomerIds]);
    } finally {
      await pool.end();
    }
    seededCustomerIds.length = 0;
  }
  await cleanupAuthenticatedUsers();
});

test("redirects signed-out booking routes to the localized login callback", async ({
  page,
}) => {
  const targets = [
    ["/bookings", "/login?callbackUrl=%2Fbookings"],
    ["/es/bookings", "/es/login?callbackUrl=%2Fbookings"],
    ["/ca/bookings", "/ca/login?callbackUrl=%2Fbookings"],
  ] as const;

  for (const [path, expected] of targets) {
    await page.goto(path);
    await expect(page).toHaveURL(
      new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );
  }
});

test("keeps a non-administrator out of the integration settings", async ({
  page,
  context,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser({ name: "Operator" });
  await installAuthSessionCookie(context, seeded.sessionToken, baseURL ?? "http://127.0.0.1:3100");

  await page.goto("/bookings/settings");

  await expect(page).toHaveURL(/\/bookings$/);
});

test("takes a request from received to awaiting payment and records the decision", async ({
  page,
  context,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser({ name: "Operator" });
  await installAuthSessionCookie(context, seeded.sessionToken, baseURL ?? "http://127.0.0.1:3100");
  const booking = await seedBookingRequest();

  await page.goto("/bookings");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(booking.customerName)).toBeVisible();

  await page.goto(`/bookings/${booking.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Approval is unavailable until the request has been opened for review.
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();

  await expect.poll(() => readBookingState(booking.id)).toBe("AWAITING_PAYMENT");

  const events = await readAuditTrail(booking.id);
  expect(events.map((event) => event.toState)).toEqual([
    "IN_REVIEW",
    "APPROVED",
    "AWAITING_PAYMENT",
  ]);
  expect(events.every((event) => event.actorUserId === seeded.userId)).toBe(true);

  // The Holded work is queued, never performed inside the operator's request.
  expect(await countQueuedQuotes(booking.id)).toBe(1);
});

test("requires a reason to reject and records it", async ({ page, context, baseURL }) => {
  const seeded = await seedAuthenticatedUser({ name: "Operator" });
  await installAuthSessionCookie(context, seeded.sessionToken, baseURL ?? "http://127.0.0.1:3100");
  const booking = await seedBookingRequest();

  await page.goto(`/bookings/${booking.id}`);

  const reason = page.getByLabel("Reason");
  await expect(reason).toBeVisible();
  await reason.fill("The dates are no longer available");
  await page.getByRole("button", { name: "Reject" }).click();

  await expect.poll(() => readBookingState(booking.id)).toBe("REJECTED");

  const events = await readAuditTrail(booking.id);
  const rejection = events.find((event) => event.toState === "REJECTED");
  expect(rejection?.reason).toBe("The dates are no longer available");
});
