import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";

import caMessages from "../../src/messages/ca.json";
import enMessages from "../../src/messages/en.json";
import esMessages from "../../src/messages/es.json";

import {
  cleanupAuthenticatedUsers,
  installAuthSessionCookie,
  seedAuthenticatedUser,
} from "./helpers/authenticated-user";

interface TreasuryAccountFixture {
  id: string;
  holdedAccountId: string;
  displayName: string;
}

interface BookingFixture {
  id: string;
  customerId: string;
}

const accountIds = new Set<string>();
const bookingIds = new Set<string>();
const customerIds = new Set<string>();

const localeTargets = [
  { locale: "en", path: "/bank-movements", messages: enMessages.BankMovements },
  { locale: "es", path: "/es/bank-movements", messages: esMessages.BankMovements },
  { locale: "ca", path: "/ca/bank-movements", messages: caMessages.BankMovements },
] as const;

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for bank movement E2E fixtures");
  }
  return new Pool({ connectionString });
}

function localId() {
  return `c${randomUUID().replaceAll("-", "")}`;
}

function providerId() {
  return randomBytes(12).toString("hex");
}

async function seedActor(role: "OPERATOR" | "ADMINISTRATOR") {
  const seeded = await seedAuthenticatedUser({ name: `${role} Banking User` });
  if (role === "ADMINISTRATOR") {
    const pool = getPool();
    try {
      await pool.query(`UPDATE "User" SET "role" = $2 WHERE "id" = $1`, [
        seeded.userId,
        role,
      ]);
    } finally {
      await pool.end();
    }
  }
  return seeded;
}

async function seedTreasuryAccount(options: {
  configuredById: string;
  active?: boolean;
  displayName?: string;
  lastSuccessfulAt?: Date | null;
}): Promise<TreasuryAccountFixture> {
  const fixture = {
    id: localId(),
    holdedAccountId: providerId(),
    displayName: options.displayName ?? "E2E treasury account",
  };
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "HoldedTreasuryAccount"
         ("id","holdedAccountId","displayName","currency","importStartDate","active",
          "configuredById","nextScheduledAt","lastSuccessfulAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,'EUR','2025-01-01',$4,$5,'2100-01-01',$6,NOW(),NOW())`,
      [
        fixture.id,
        fixture.holdedAccountId,
        fixture.displayName,
        options.active ?? false,
        options.configuredById,
        options.lastSuccessfulAt === undefined
          ? new Date()
          : options.lastSuccessfulAt,
      ],
    );
  } finally {
    await pool.end();
  }
  accountIds.add(fixture.id);
  return fixture;
}

async function seedMovement(
  account: TreasuryAccountFixture,
  options: {
    amountMinor: bigint;
    narrative: string;
    bookingDate?: string;
  },
) {
  const id = localId();
  const holdedMovementId = providerId();
  const direction = options.amountMinor > BigInt(0) ? "INCOME" : "EXPENSE";
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "BankMovement"
         ("id","accountId","holdedMovementId","bookingDate","valueDate","narrative",
          "amountMinor","currency","providerStatus","direction","firstSeenAt","lastSeenAt","updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,$6,'EUR','booked',$7,NOW(),NOW(),NOW())`,
      [
        id,
        account.id,
        holdedMovementId,
        options.bookingDate ?? "2025-02-01",
        options.narrative,
        options.amountMinor.toString(),
        direction,
      ],
    );
  } finally {
    await pool.end();
  }
  return { id, holdedMovementId };
}

async function seedSynchronizationRun(
  account: TreasuryAccountFixture,
  options: {
    status: "SUCCEEDED" | "RETRYING";
    failureCode?: "PROVIDER_UNAVAILABLE";
  },
) {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "BankSyncRun"
         ("id","accountId","trigger","status","windowStartDate","pageCount","itemCount",
          "insertedCount","incidentCount","attemptCount","nextAttemptAt","failureCode",
          "startedAt","exhaustedAt","finishedAt","createdAt","updatedAt")
       VALUES ($1,$2,'SCHEDULED',$3,'2025-01-01',1,1,1,$4,1,$5,$6,NOW(),$7,$7,NOW(),NOW())`,
      [
        localId(),
        account.id,
        options.status,
        options.failureCode ? 1 : 0,
        options.status === "RETRYING" ? "2100-01-01" : new Date(),
        options.failureCode ?? null,
        options.status === "SUCCEEDED" ? new Date() : null,
      ],
    );
  } finally {
    await pool.end();
  }
}

async function seedBooking(state: "IN_REVIEW" | "AWAITING_PAYMENT") {
  const fixture = { id: localId(), customerId: localId() };
  const suffix = randomUUID().slice(0, 8);
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "Customer"
         ("id","taxId","name","email","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,NOW(),NOW())`,
      [
        fixture.customerId,
        `E2E${suffix}`.toUpperCase(),
        `E2E Banking Group ${suffix}`,
        `banking-${suffix}@example.test`,
      ],
    );
    await pool.query(
      `INSERT INTO "BookingRequest"
         ("id","gravityEntryId","customerId","state","boardType","startDate","endDate",
          "headcount","advanceCents","depositCents","paymentDueAt","submittedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'SELF_CATERING','2027-06-01','2027-06-03',40,$5,$6,$7,NOW(),NOW(),NOW())`,
      [
        fixture.id,
        `e2e-bank-${suffix}`,
        fixture.customerId,
        state,
        state === "AWAITING_PAYMENT" ? 10_000 : null,
        state === "AWAITING_PAYMENT" ? 20_000 : null,
        state === "AWAITING_PAYMENT" ? new Date("2027-05-01T00:00:00.000Z") : null,
      ],
    );
  } finally {
    await pool.end();
  }
  customerIds.add(fixture.customerId);
  bookingIds.add(fixture.id);
  return fixture;
}

async function seedProposal(
  movementId: string,
  booking: BookingFixture,
  estimateNumber: string,
) {
  const proposalId = localId();
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO "HoldedDocument"
         ("id","bookingRequestId","type","holdedId","documentNumber","totalCents","issuedAt")
       VALUES ($1,$2,'ESTIMATE',$3,$4,30000,'2025-01-31')`,
      [localId(), booking.id, providerId(), estimateNumber],
    );
    await pool.query(
      `INSERT INTO "BankReconciliationProposal"
         ("id","movementId","bookingRequestId","status","createdAt","updatedAt")
       VALUES ($1,$2,$3,'PENDING',NOW(),NOW())`,
      [proposalId, movementId, booking.id],
    );
  } finally {
    await pool.end();
  }
  return proposalId;
}

async function readBookingState(bookingId: string) {
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

async function readManualRun(accountId: string) {
  const pool = getPool();
  try {
    const result = await pool.query<{
      status: string;
      trigger: string;
      requestedById: string | null;
    }>(
      `SELECT "status","trigger","requestedById" FROM "BankSyncRun"
       WHERE "accountId" = $1 AND "trigger" = 'MANUAL'
       ORDER BY "createdAt" DESC LIMIT 1`,
      [accountId],
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

async function readReconciliation(proposalId: string, bookingId: string) {
  const pool = getPool();
  try {
    const [proposal, booking, payment] = await Promise.all([
      pool.query<{ status: string; decidedById: string | null }>(
        `SELECT "status","decidedById" FROM "BankReconciliationProposal" WHERE "id" = $1`,
        [proposalId],
      ),
      pool.query<{ state: string }>(
        `SELECT "state" FROM "BookingRequest" WHERE "id" = $1`,
        [bookingId],
      ),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS "count" FROM "Payment" WHERE "bookingRequestId" = $1`,
        [bookingId],
      ),
    ]);
    return {
      proposalStatus: proposal.rows[0]?.status,
      decidedById: proposal.rows[0]?.decidedById,
      bookingState: booking.rows[0]?.state,
      paymentCount: payment.rows[0]?.count ?? 0,
    };
  } finally {
    await pool.end();
  }
}

async function cleanupBankingFixtures() {
  if (accountIds.size === 0 && bookingIds.size === 0 && customerIds.size === 0) {
    return;
  }
  const trackedAccounts = [...accountIds];
  const trackedBookings = [...bookingIds];
  const trackedCustomers = [...customerIds];
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM "IntegrationJob"
       WHERE "idempotencyKey" LIKE ANY($1::text[])`,
      [trackedBookings.map((id) => `%:${id}`)],
    );
    await pool.query(
      `DELETE FROM "BankReconciliationProposal"
       WHERE "bookingRequestId" = ANY($1::text[])
          OR "movementId" IN (
            SELECT "id" FROM "BankMovement" WHERE "accountId" = ANY($2::text[])
          )`,
      [trackedBookings, trackedAccounts],
    );
    await pool.query(
      `DELETE FROM "Payment" WHERE "bookingRequestId" = ANY($1::text[])`,
      [trackedBookings],
    );
    await pool.query(
      `DELETE FROM "HoldedDocument" WHERE "bookingRequestId" = ANY($1::text[])`,
      [trackedBookings],
    );
    await pool.query(
      `DELETE FROM "BookingAuditEvent" WHERE "bookingRequestId" = ANY($1::text[])`,
      [trackedBookings],
    );
    await pool.query(
      `DELETE FROM "BookingRequest" WHERE "id" = ANY($1::text[])`,
      [trackedBookings],
    );
    await pool.query(`DELETE FROM "Customer" WHERE "id" = ANY($1::text[])`, [
      trackedCustomers,
    ]);
    await pool.query(
      `DELETE FROM "BankSyncRun" WHERE "accountId" = ANY($1::text[])`,
      [trackedAccounts],
    );
    await pool.query(
      `DELETE FROM "BankMovement" WHERE "accountId" = ANY($1::text[])`,
      [trackedAccounts],
    );
    await pool.query(
      `DELETE FROM "HoldedTreasuryAccount" WHERE "id" = ANY($1::text[])`,
      [trackedAccounts],
    );
  } finally {
    accountIds.clear();
    bookingIds.clear();
    customerIds.clear();
    await pool.end();
  }
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

function formatEuros(value: number) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "never",
  }).format(value);
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  await cleanupBankingFixtures();
  await cleanupAuthenticatedUsers();
});

test("redirects signed-out banking routes to each localized login", async ({ page }) => {
  const targets = [
    ["/bank-movements", "/login?callbackUrl=%2Fbank-movements"],
    ["/es/bank-movements", "/es/login?callbackUrl=%2Fbank-movements"],
    ["/ca/bank-movements", "/ca/login?callbackUrl=%2Fbank-movements"],
  ] as const;

  for (const [path, expected] of targets) {
    await page.goto(path);
    await expect(page).toHaveURL(
      new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`),
    );
  }
});

test("allows operator and administrator roles across all locales with noindex", async ({
  page,
  context,
  baseURL,
}) => {
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const operator = await seedActor("OPERATOR");
  await installAuthSessionCookie(context, operator.sessionToken, appUrl);

  for (const target of localeTargets) {
    const response = await page.goto(target.path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", target.locale);
    await expect(
      page.getByRole("heading", { level: 1, name: target.messages.title }),
    ).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/i,
    );
  }

  const administrator = await seedActor("ADMINISTRATOR");
  await installAuthSessionCookie(context, administrator.sessionToken, appUrl);
  await context.addCookies([
    {
      name: "NEXT_LOCALE",
      value: "en",
      url: new URL(appUrl).origin,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/bank-movements");
  await expect(
    page.getByRole("heading", { level: 1, name: enMessages.BankMovements.title }),
  ).toBeVisible();
});

test("computes full filtered totals beyond the visible page and applies filters", async ({
  page,
  context,
  baseURL,
}) => {
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(
    context,
    actor.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  const account = await seedTreasuryAccount({
    configuredById: actor.userId,
    displayName: "Totals account",
  });
  for (let index = 0; index < 51; index += 1) {
    await seedMovement(account, {
      amountMinor: BigInt(100),
      narrative: `Income movement ${String(index).padStart(2, "0")}`,
    });
  }
  await seedMovement(account, {
    amountMinor: BigInt(-200),
    narrative: "Needle expense movement",
    bookingDate: "2025-01-31",
  });

  await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
  await expect(page.locator('tbody tr[data-direction="income"]')).toHaveCount(50);
  const totals = page.getByRole("region", {
    name: enMessages.BankMovements.totals.title,
  });
  await expect(totals).toContainText(formatEuros(51));
  await expect(totals).toContainText(formatEuros(2));
  await expect(
    page.getByRole("navigation", { name: "Page 1 of 2" }),
  ).toBeVisible();

  await page
    .getByLabel(enMessages.BankMovements.filters.direction)
    .selectOption("expense");
  await expect(page).toHaveURL(/direction=expense/u);
  await expect(page.locator('tbody tr[data-direction="expense"]')).toHaveCount(1);
  await expect(page.getByText("Needle expense movement", { exact: true })).toBeVisible();
  await expect(totals).toContainText(formatEuros(2));
  await expect(totals).not.toContainText(formatEuros(51));
});

test("requests a manual refresh by keyboard and exposes durable queued progress", async ({
  page,
  context,
  baseURL,
}) => {
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(
    context,
    actor.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  const account = await seedTreasuryAccount({
    configuredById: actor.userId,
    active: true,
  });

  await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
  const refresh = page.getByRole("button", {
    name: enMessages.BankMovements.synchronization.refresh,
  });
  await tabTo(page, refresh);
  await page.keyboard.press("Enter");

  await expect(
    page.getByText(enMessages.BankMovements.synchronization.accepted),
  ).toBeVisible();
  await expect.poll(() => readManualRun(account.id)).toMatchObject({
    trigger: "MANUAL",
    requestedById: actor.userId,
  });
  await expect(
    page.getByText(
      /Waiting to synchronize|Synchronization in progress/u,
    ),
  ).toBeVisible();
});

test("confirms a reconciliation proposal manually by keyboard", async ({
  page,
  context,
  baseURL,
}) => {
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(
    context,
    actor.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  const account = await seedTreasuryAccount({ configuredById: actor.userId });
  const estimateNumber = `EST-${randomUUID().slice(0, 8)}`;
  const movement = await seedMovement(account, {
    amountMinor: BigInt(30_000),
    narrative: `Transfer for ${estimateNumber}`,
  });
  const booking = await seedBooking("AWAITING_PAYMENT");
  const proposalId = await seedProposal(movement.id, booking, estimateNumber);

  await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
  await expect(
    page.getByText(enMessages.BankMovements.proposals.title, { exact: true }),
  ).toBeVisible();
  const confirm = page.getByRole("button", {
    name: enMessages.BankMovements.proposals.confirm,
  });
  await tabTo(page, confirm);
  await page.keyboard.press("Enter");

  await expect.poll(() => readReconciliation(proposalId, booking.id)).toEqual({
    proposalStatus: "CONFIRMED",
    decidedById: actor.userId,
    bookingState: "CONFIRMED",
    paymentCount: 1,
  });
  await expect(
    page.getByText(enMessages.BankMovements.proposals.confirmedAnnouncement),
  ).toBeVisible();
});

test("keeps movements and unrelated booking decisions available during Holded outage", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const actor = await seedActor("OPERATOR");
  await installAuthSessionCookie(
    context,
    actor.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  const account = await seedTreasuryAccount({
    configuredById: actor.userId,
    active: true,
    lastSuccessfulAt: new Date("2025-01-01T00:00:00.000Z"),
  });
  await seedMovement(account, {
    amountMinor: BigInt(12_500),
    narrative: "Retained movement during outage",
  });
  await seedSynchronizationRun(account, {
    status: "RETRYING",
    failureCode: "PROVIDER_UNAVAILABLE",
  });

  await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
  await expect(
    page.getByText(enMessages.BankMovements.synchronization.state.retrying),
  ).toBeVisible();
  await expect(
    page.getByText(
      enMessages.BankMovements.synchronization.incidents.PROVIDER_UNAVAILABLE,
    ),
  ).toBeVisible();
  await expect(page.getByText("Retained movement during outage")).toBeVisible();
  await expect(
    page.getByText(enMessages.BankMovements.synchronization.retainedData),
  ).toBeVisible();
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toMatchObject({
    status: "ok",
    database: "ok",
  });

  const booking = await seedBooking("IN_REVIEW");
  await page.goto(`/bookings/${booking.id}`);
  await page.getByLabel("Reason").fill("Unavailable dates during banking outage");
  await page.getByRole("button", { name: "Reject" }).click();
  await expect.poll(() => readBookingState(booking.id)).toBe("REJECTED");
});

test(
  "keeps a long banking view contained and usable at 320px",
  { tag: "@mobile" },
  async ({ page, context, baseURL }) => {
    const actor = await seedActor("OPERATOR");
    await installAuthSessionCookie(
      context,
      actor.sessionToken,
      baseURL ?? "http://127.0.0.1:3100",
    );
    const account = await seedTreasuryAccount({
      configuredById: actor.userId,
      displayName: "Long treasury account name for narrow viewport validation",
    });
    await seedMovement(account, {
      amountMinor: BigInt(12_345),
      narrative:
        "A deliberately long synthetic movement concept that must stay inside the scrollable table",
    });

    await page.goto(`/bank-movements?account=${account.holdedAccountId}`);
    expect(page.viewportSize()?.width).toBe(320);
    await expect(
      page.getByRole("heading", { level: 1, name: enMessages.BankMovements.title }),
    ).toBeVisible();
    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const tableContainer = document.querySelector<HTMLElement>(
        '[data-slot="table-container"]',
      );
      const controls = [
        ...document.querySelectorAll<HTMLElement>("main button, main input, main select"),
      ].filter((element) => element.getClientRects().length > 0);
      return {
        rootOverflow: root.scrollWidth > root.clientWidth + 1,
        tableScrolls: Boolean(
          tableContainer && tableContainer.scrollWidth > tableContainer.clientWidth,
        ),
        outOfBounds: controls.filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < -0.5 || box.right > window.innerWidth + 0.5;
        }).length,
      };
    });
    expect(geometry).toEqual({
      rootOverflow: false,
      tableScrolls: true,
      outOfBounds: 0,
    });
  },
);