// @vitest-environment node

import "dotenv/config";

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const providerMocks = vi.hoisted(() => ({
  createHoldedClient: vi.fn(),
  listTreasuryAccounts: vi.fn(),
  resolveIntegration: vi.fn(),
}));

vi.mock("@/lib/holded/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/holded/client")>();
  return { ...original, createHoldedClient: providerMocks.createHoldedClient };
});
vi.mock("@/modules/booking/services/settings", () => ({
  resolveIntegration: providerMocks.resolveIntegration,
}));

import { db } from "@/lib/db";
import { HoldedError } from "@/lib/holded/client";
import {
  BANK_SYNC_INITIAL_RETRY_MS,
  BANK_SYNC_LEASE_MS,
  BANK_SYNC_MANUAL_COOLDOWN_MS,
  BANK_SYNC_MAX_ATTEMPTS,
  BANK_SYNC_MAX_RETRY_MS,
} from "@/modules/banking/schema";
import { saveTreasuryAccount } from "@/modules/banking/services/accounts";
import {
  claimNextBankSync,
  enqueueBankSync,
  enqueueDueBankSyncRuns,
  processBankSync,
  requestManualBankSync,
  type BankMovementPage,
  type BankMovementProvider,
} from "@/modules/banking/services/synchronization";
import { createBankingFixtureScope } from "../helpers/banking";
import { createHoldedTreasuryFixtureScope } from "../helpers/holded-treasury";
import {
  queryBankMovements,
  type BankMovementFilters,
} from "@/modules/banking/services/queries";

const databaseUrl = process.env.DATABASE_URL;
const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";
const migrationRoot = path.join(process.cwd(), "prisma/migrations");
const bankingMigrationName = "20260916000000_holded_bank_movements";
const bankingMigration = path.join(
  migrationRoot,
  bankingMigrationName,
  "migration.sql",
);
const openClients = new Set<Client>();
const schemas = new Set<string>();
const fixtureScopes = new Set<ReturnType<typeof createBankingFixtureScope>>();

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function applyMigration(client: Client, migrationPath: string) {
  const sql = await readFile(migrationPath, "utf8");
  const leadingEnumAddition = sql.match(
    /^(ALTER TYPE [^;]+ ADD VALUE(?: IF NOT EXISTS)? [^;]+;)\s*/u,
  );
  if (leadingEnumAddition) {
    await client.query(leadingEnumAddition[1]);
    await client.query(sql.slice(leadingEnumAddition[0].length));
    return;
  }
  await client.query(sql);
}

async function createSchema() {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString: databaseUrl });
  const schema = `bank_migration_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  openClients.add(client);
  schemas.add(schema);
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  return client;
}

async function applyPreBankingMigrations(client: Client) {
  const directories = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name < bankingMigrationName,
    )
    .map((entry) => entry.name)
    .sort();

  for (const directory of directories) {
    await applyMigration(client, path.join(migrationRoot, directory, "migration.sql"));
  }
}

afterEach(async () => {
  await Promise.all(
    [...fixtureScopes].map(async (scope) => {
      await scope.cleanup();
      fixtureScopes.delete(scope);
    }),
  );
  await Promise.all(
    [...openClients].map(async (client) => {
      await client.end();
      openClients.delete(client);
    }),
  );
  vi.clearAllMocks();
});

afterAll(async () => {
  if (!databaseUrl || schemas.size === 0) return;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const schema of schemas) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  } finally {
    await client.end();
  }
});

describe.skipIf(!runIntegrationTests || !databaseUrl)(
  "Holded bank movement migration",
  () => {
    it("adds the complete additive schema and preserves an existing payment", async () => {
      const client = await createSchema();
      await applyPreBankingMigrations(client);
      await client.query(`
        INSERT INTO "User" (
          "id", "email", "normalizedEmail", "status", "role", "createdAt", "updatedAt"
        ) VALUES (
          'bank-user', 'bank-user@example.test', 'bank-user@example.test',
          'ACTIVE', 'OPERATOR', NOW(), NOW()
        );
        INSERT INTO "Customer" (
          "id", "taxId", "name", "email", "createdAt", "updatedAt"
        ) VALUES (
          'bank-customer', 'BANK-CUSTOMER', 'Synthetic Customer',
          'bank-customer@example.test', NOW(), NOW()
        );
        INSERT INTO "BookingRequest" (
          "id", "gravityEntryId", "customerId", "state", "boardType", "startDate",
          "endDate", "headcount", "submittedAt", "createdAt", "updatedAt"
        ) VALUES (
          'bank-booking', 'bank-entry', 'bank-customer', 'AWAITING_PAYMENT',
          'SELF_CATERING', DATE '2026-10-01', DATE '2026-10-03', 30, NOW(), NOW(), NOW()
        );
        INSERT INTO "Payment" (
          "id", "bookingRequestId", "amountCents", "receivedAt", "recordedById", "createdAt"
        ) VALUES ('legacy-payment', 'bank-booking', 30000, NOW(), 'bank-user', NOW());
      `);

      await applyMigration(client, bankingMigration);

      const tables = await client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN (
            'HoldedTreasuryAccount', 'BankMovement', 'BankSyncRun',
            'BankSyncIncident', 'BankReconciliationProposal'
          )
        ORDER BY table_name
      `);
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "BankMovement",
        "BankReconciliationProposal",
        "BankSyncIncident",
        "BankSyncRun",
        "HoldedTreasuryAccount",
      ]);

      const columns = await client.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
      }>(`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name, column_name) IN (
            ('HoldedTreasuryAccount', 'retentionFloorDate'),
            ('BankSyncRun', 'exhaustedAt'),
            ('Payment', 'bankMovementId')
          )
        ORDER BY table_name, column_name
      `);
      expect(columns.rows).toEqual([
        {
          table_name: "BankSyncRun",
          column_name: "exhaustedAt",
          is_nullable: "YES",
        },
        {
          table_name: "HoldedTreasuryAccount",
          column_name: "retentionFloorDate",
          is_nullable: "YES",
        },
        {
          table_name: "Payment",
          column_name: "bankMovementId",
          is_nullable: "YES",
        },
      ]);

      const payment = await client.query<{ bankMovementId: string | null }>(
        `SELECT "bankMovementId" FROM "Payment" WHERE "id" = 'legacy-payment'`,
      );
      expect(payment.rows).toEqual([{ bankMovementId: null }]);
    });

    it("installs banking enums, checks, and partial uniqueness", async () => {
      const client = await createSchema();
      await applyPreBankingMigrations(client);
      await applyMigration(client, bankingMigration);

      const enums = await client.query<{ enum_name: string; enum_value: string }>(`
        SELECT type.typname AS enum_name, enum.enumlabel AS enum_value
        FROM pg_type type
        JOIN pg_enum enum ON enum.enumtypid = type.oid
        JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
        WHERE namespace.nspname = current_schema()
          AND type.typname LIKE 'Bank%'
        ORDER BY type.typname, enum.enumsortorder
      `);
      const valuesByEnum = Object.groupBy(
        enums.rows,
        (row) => row.enum_name,
      );
      expect(Object.keys(valuesByEnum).sort()).toEqual([
        "BankMovementDirection",
        "BankReconciliationStatus",
        "BankSyncIncidentCode",
        "BankSyncStatus",
        "BankSyncTrigger",
      ]);
      expect(
        valuesByEnum.BankSyncIncidentCode?.map((row) => row.enum_value),
      ).toContain("PROVIDER_REQUEST_REJECTED");

      const constraints = await client.query<{ name: string; definition: string }>(`
        SELECT constraint_name AS name,
               pg_get_constraintdef(pg_constraint.oid) AS definition
        FROM information_schema.table_constraints
        JOIN pg_constraint ON pg_constraint.conname = constraint_name
        JOIN pg_namespace ON pg_namespace.oid = pg_constraint.connamespace
        WHERE table_schema = current_schema()
          AND pg_namespace.nspname = current_schema()
          AND constraint_type = 'CHECK'
          AND constraint_name LIKE 'Bank%'
        ORDER BY constraint_name
      `);
      expect(constraints.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "BankMovement_amount_nonzero_check",
          "BankMovement_direction_sign_check",
          "BankSyncIncident_item_index_check",
          "BankSyncIncident_page_number_check",
          "BankSyncRun_counters_nonnegative_check",
        ]),
      );

      const indexes = await client.query<{ indexname: string; indexdef: string }>(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname IN (
            'HoldedTreasuryAccount_one_active_idx',
            'BankSyncRun_one_nonterminal_per_account_idx',
            'BankMovement_accountId_holdedMovementId_key',
            'Payment_bankMovementId_key'
          )
        ORDER BY indexname
      `);
      expect(indexes.rows).toHaveLength(4);
      expect(
        indexes.rows.find(
          (row) => row.indexname === "HoldedTreasuryAccount_one_active_idx",
        )?.indexdef,
      ).toContain("WHERE (active = true)");
      expect(
        indexes.rows.find(
          (row) => row.indexname === "BankSyncRun_one_nonterminal_per_account_idx",
        )?.indexdef,
      ).toMatch(/WHERE.*(QUEUED|RUNNING|RETRYING)/u);
    });
  },
);

function movementFilters(
  overrides: Partial<BankMovementFilters> = {},
): BankMovementFilters {
  return {
    direction: "all",
    from: undefined,
    to: undefined,
    account: undefined,
    currency: undefined,
    q: "",
    page: 1,
    ...overrides,
  };
}

describe.skipIf(!runIntegrationTests || !databaseUrl)(
  "bank movement queries",
  () => {
    it("combines every filter and keeps inactive account history available", async () => {
      const scope = bankingScope("bank-query-filters");
      const firstData = scope.treasuryAccount({
        displayName: "Alpha synthetic account",
        active: true,
      });
      const secondData = scope.treasuryAccount({
        displayName: "Beta historical account",
        active: false,
      });
      await db.holdedTreasuryAccount.createMany({ data: [firstData, secondData] });

      const movements = [
        scope.movement(firstData, {
          holdedMovementId: "000000000000000000000001",
          bookingDate: new Date("2026-09-10T00:00:00.000Z"),
          narrative: "Synthetic alpha incoming",
          amountMinor: BigInt(1_000),
          currency: "EUR",
          providerStatus: "settled",
        }),
        scope.movement(firstData, {
          holdedMovementId: "000000000000000000000002",
          bookingDate: new Date("2026-09-11T00:00:00.000Z"),
          narrative: "Synthetic alpha outgoing",
          amountMinor: BigInt(-300),
          currency: "EUR",
          providerStatus: null,
        }),
        scope.movement(secondData, {
          holdedMovementId: "000000000000000000000003",
          bookingDate: new Date("2026-09-12T00:00:00.000Z"),
          valueDate: null,
          narrative: "Synthetic BETA reference",
          amountMinor: BigInt(2_500),
          currency: "USD",
          providerStatus: "reconciled",
        }),
        scope.movement(secondData, {
          holdedMovementId: "000000000000000000000004",
          bookingDate: new Date("2026-09-13T00:00:00.000Z"),
          narrative: null,
          amountMinor: BigInt(-500),
          currency: "USD",
          providerStatus: null,
        }),
      ];
      await db.bankMovement.createMany({ data: movements });

      await expect(
        queryBankMovements(movementFilters({ direction: "income" })),
      ).resolves.toMatchObject({
        rows: [{ id: movements[2]!.id }, { id: movements[0]!.id }],
        totalRows: 2,
      });
      await expect(
        queryBankMovements(
          movementFilters({ from: "2026-09-11", to: "2026-09-12" }),
        ),
      ).resolves.toMatchObject({
        rows: [{ id: movements[2]!.id }, { id: movements[1]!.id }],
        totalRows: 2,
      });
      await expect(
        queryBankMovements(
          movementFilters({ account: secondData.holdedAccountId }),
        ),
      ).resolves.toMatchObject({
        rows: [{ id: movements[3]!.id }, { id: movements[2]!.id }],
        totalRows: 2,
      });
      await expect(
        queryBankMovements(movementFilters({ currency: "USD" })),
      ).resolves.toMatchObject({ totalRows: 2 });
      await expect(
        queryBankMovements(movementFilters({ q: "beta REFERENCE" })),
      ).resolves.toMatchObject({
        rows: [{ id: movements[2]!.id }],
        totalRows: 1,
      });

      const combined = await queryBankMovements(
        movementFilters({
          direction: "income",
          from: "2026-09-12",
          to: "2026-09-12",
          account: secondData.holdedAccountId,
          currency: "USD",
          q: "beta reference",
        }),
      );
      expect(combined.rows).toEqual([
        expect.objectContaining({
          id: movements[2]!.id,
          date: "2026-09-12",
          valueDate: null,
          concept: "Synthetic BETA reference",
          reference: "Synthetic BETA reference",
          counterparty: null,
          amountMinor: "2500",
          status: "pending",
          direction: "income",
          account: {
            id: secondData.holdedAccountId,
            name: secondData.displayName,
          },
        }),
      ]);
      expect(combined.accounts).toEqual(
        expect.arrayContaining([
          { id: firstData.holdedAccountId, name: firstData.displayName },
          { id: secondData.holdedAccountId, name: secondData.displayName },
        ]),
      );
    });

    it("returns stable 50-row pages without leaking BigInt values", async () => {
      const scope = bankingScope("bank-query-pages");
      const accountData = scope.treasuryAccount();
      await db.holdedTreasuryAccount.create({ data: accountData });
      const movements = Array.from({ length: 55 }, (_, index) =>
        scope.movement(accountData, {
          holdedMovementId: (index + 1).toString(16).padStart(24, "0"),
          bookingDate: new Date("2026-09-15T00:00:00.000Z"),
          amountMinor: BigInt(100),
        }),
      );
      await db.bankMovement.createMany({ data: movements });

      const first = await queryBankMovements(movementFilters());
      const second = await queryBankMovements(movementFilters({ page: 2 }));

      expect(first).toMatchObject({ page: 1, pageSize: 50, totalRows: 55 });
      expect(second).toMatchObject({ page: 2, pageSize: 50, totalRows: 55 });
      expect(first.rows).toHaveLength(50);
      expect(second.rows).toHaveLength(5);
      expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual(
        movements.map((movement) => movement.id),
      );
      expect(JSON.stringify(first)).not.toContain("BigInt");
      expect(first.rows.every((row) => typeof row.amountMinor === "string")).toBe(
        true,
      );
    });

    it("calculates full-filter income and expense totals separately by currency", async () => {
      const scope = bankingScope("bank-query-totals");
      const accountData = scope.treasuryAccount();
      await db.holdedTreasuryAccount.create({ data: accountData });
      const movements = [
        ...Array.from({ length: 51 }, (_, index) =>
          scope.movement(accountData, {
            holdedMovementId: (index + 1).toString(16).padStart(24, "0"),
            amountMinor: BigInt(100),
            currency: "EUR",
          }),
        ),
        scope.movement(accountData, {
          holdedMovementId: "eeeeeeeeeeeeeeeeeeeeeeee",
          amountMinor: BigInt(-250),
          currency: "EUR",
        }),
        scope.movement(accountData, {
          holdedMovementId: "ffffffffffffffffffffffff",
          amountMinor: BigInt(500),
          currency: "USD",
        }),
      ];
      await db.bankMovement.createMany({ data: movements });

      const first = await queryBankMovements(movementFilters());
      const second = await queryBankMovements(movementFilters({ page: 2 }));

      expect(first.rows).toHaveLength(50);
      expect(first.totals).toEqual([
        { currency: "EUR", incomeMinor: "5100", expenseMinor: "250" },
        { currency: "USD", incomeMinor: "500", expenseMinor: "0" },
      ]);
      expect(second.totals).toEqual(first.totals);
      expect(first.currencies).toEqual(["EUR", "USD"]);
    });

    it("projects the latest active-account run, cooldown, and sanitized incidents", async () => {
      const scope = bankingScope("bank-query-synchronization");
      const now = new Date("2026-09-16T18:00:00.000Z");
      const latestSuccessfulAt = new Date("2026-09-16T11:59:59.999Z");
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({
        data: { ...accountData, lastSuccessfulAt: latestSuccessfulAt },
      });
      const customer = await db.customer.create({ data: scope.customer() });
      const booking = await db.bookingRequest.create({
        data: scope.booking(customer),
      });
      const movement = await db.bankMovement.create({
        data: scope.movement(accountData),
      });
      await db.bankReconciliationProposal.create({
        data: {
          movementId: movement.id,
          bookingRequestId: booking.id,
          status: "PENDING",
        },
      });

      const createdAt = new Date("2026-09-16T17:59:30.000Z");
      const run = await db.bankSyncRun.create({
        data: {
          ...scope.run(accountData, {
            status: "FAILED",
            finishedAt: new Date("2026-09-16T17:59:50.000Z"),
          }),
          pageCount: 0,
          itemCount: 2,
          insertedCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          incidentCount: 2,
          attemptCount: 6,
          failureCode: "PROVIDER_UNAVAILABLE",
          startedAt: createdAt,
          createdAt,
          nextCursor: "sensitive-provider-cursor",
        },
      });
      const sensitiveMovementId = "ffffffffffffffffffffffff";
      await db.bankSyncIncident.createMany({
        data: [
          {
            runId: run.id,
            code: "INVALID_AMOUNT",
            pageNumber: 1,
            itemIndex: 0,
            holdedMovementId: sensitiveMovementId,
          },
          {
            runId: run.id,
            code: "MISSING_CURSOR",
            pageNumber: 1,
            itemIndex: null,
          },
        ],
      });

      const projection = await queryBankMovements(movementFilters(), { now });

      expect(projection.synchronization).toEqual({
        configured: true,
        latestRun: {
          id: run.id,
          status: "FAILED",
          trigger: "MANUAL",
          pageCount: 0,
          itemCount: 2,
          insertedCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          incidentCount: 2,
          attemptCount: 6,
          failureCode: "PROVIDER_UNAVAILABLE",
          createdAt: createdAt.toISOString(),
          startedAt: createdAt.toISOString(),
          nextAttemptAt: "2026-09-16T10:00:00.000Z",
          finishedAt: "2026-09-16T17:59:50.000Z",
          retryEligible: true,
        },
        latestSuccessfulAt: latestSuccessfulAt.toISOString(),
        incidents: [
          { code: "INVALID_AMOUNT", pageNumber: 1, itemIndex: 0 },
          { code: "MISSING_CURSOR", pageNumber: 1, itemIndex: null },
        ],
        pendingProposalCount: 1,
        integrationState: "failed",
        manualRefreshAllowed: false,
        manualRefreshAvailableAt: "2026-09-16T18:00:30.000Z",
      });
      expect(JSON.stringify(projection.synchronization)).not.toContain(
        "sensitive-provider-cursor",
      );
      expect(JSON.stringify(projection.synchronization)).not.toContain(
        sensitiveMovementId,
      );
      expect(account.id).toBe(accountData.id);
    });
  },
);

function bankingScope(label: string) {
  const scope = createBankingFixtureScope(label);
  fixtureScopes.add(scope);
  return scope;
}

function syntheticProvider(pages: BankMovementPage[]): BankMovementProvider & {
  listBankMovements: ReturnType<typeof vi.fn>;
} {
  let pageIndex = 0;
  const listBankMovements = vi.fn(async () => {
    const page = pages[pageIndex++];
    if (!page) throw new Error("Unexpected synthetic provider page request");
    return page;
  });
  return { listBankMovements };
}

async function executeRun(
  accountId: string,
  provider: BankMovementProvider,
  now = new Date("2026-09-16T12:00:00.000Z"),
) {
  const enqueued = await enqueueBankSync({
    accountId,
    trigger: "MANUAL",
    now,
  });
  const lease = await claimNextBankSync(now);
  expect(lease?.runId).toBe(enqueued.runId);
  if (!lease) throw new Error("Expected a bank synchronization lease");
  await processBankSync(lease, { provider, now: () => now });
  return db.bankSyncRun.findUniqueOrThrow({ where: { id: enqueued.runId } });
}

describe.skipIf(!runIntegrationTests || !databaseUrl)(
  "Holded bank movement synchronization",
  () => {
    it("switches active accounts while preserving historical scopes", async () => {
      const scope = bankingScope("bank-switch");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const firstData = scope.treasuryAccount({ active: true });
      const first = await db.holdedTreasuryAccount.create({ data: firstData });
      const historical = scope.movement(firstData);
      await db.bankMovement.create({ data: historical });
      const administratorData = scope.user({ role: "ADMINISTRATOR" });
      const administrator = await db.user.create({ data: administratorData });
      const selected = providerFixtures.account({ name: "New synthetic account" });
      const selectedData = scope.treasuryAccount({
        holdedAccountId: selected.id,
        displayName: "Previous synthetic name",
        active: false,
      });
      await db.holdedTreasuryAccount.create({ data: selectedData });
      providerMocks.resolveIntegration.mockResolvedValue({
        config: {},
        secret: "synthetic-stored-secret",
      });
      providerMocks.listTreasuryAccounts.mockResolvedValue([selected]);
      providerMocks.createHoldedClient.mockReturnValue({
        listTreasuryAccounts: providerMocks.listTreasuryAccounts,
      });

      const saved = await saveTreasuryAccount({
        holdedAccountId: selected.id,
        importStartDate: "2026-06-18",
        configuredById: administrator.id,
      });

      const accounts = await db.holdedTreasuryAccount.findMany({
        where: { id: { in: [first.id, saved.accountId] } },
        orderBy: { createdAt: "asc" },
      });
      expect(accounts).toMatchObject([
        { id: first.id, active: false },
        {
          id: saved.accountId,
          holdedAccountId: selected.id,
          displayName: selected.name,
          currency: "EUR",
          active: true,
        },
      ]);
      await expect(
        db.bankMovement.findUniqueOrThrow({ where: { id: historical.id } }),
      ).resolves.toMatchObject({ accountId: first.id });
      if (!saved.runId) throw new Error("Expected a first synchronization run");
      await expect(
        db.bankSyncRun.findUniqueOrThrow({ where: { id: saved.runId } }),
      ).resolves.toMatchObject({ accountId: saved.accountId, status: "QUEUED" });
    });

    it("commits every advertised page and exact run counters", async () => {
      const scope = bankingScope("bank-pages");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const first = providerFixtures.movement(account.holdedAccountId, {
        amount: "125.50",
      });
      const second = providerFixtures.movement(account.holdedAccountId, {
        amount: "-20.00",
      });
      const third = providerFixtures.movement(account.holdedAccountId, {
        amount: "5.25",
      });
      const provider = syntheticProvider([
        { items: [second, first], hasMore: true, cursor: "synthetic-next" },
        { items: [third], hasMore: false, cursor: null },
      ]);

      const run = await executeRun(account.id, provider);

      expect(run).toMatchObject({
        status: "SUCCEEDED",
        pageCount: 2,
        itemCount: 3,
        insertedCount: 3,
        updatedCount: 0,
        unchangedCount: 0,
        incidentCount: 0,
        nextCursor: null,
      });
      expect(run.exhaustedAt).not.toBeNull();
      expect(run.finishedAt).not.toBeNull();
      expect(provider.listBankMovements).toHaveBeenNthCalledWith(1, {
        accountId: account.holdedAccountId,
        startDate: "2026-06-18",
        cursor: undefined,
      });
      expect(provider.listBankMovements).toHaveBeenNthCalledWith(2, {
        accountId: account.holdedAccountId,
        startDate: "2026-06-18",
        cursor: "synthetic-next",
      });
    });

    it("creates an exact reconciliation proposal in the imported page", async () => {
      const scope = bankingScope("bank-page-reconciliation");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const customerData = scope.customer();
      await db.customer.create({ data: customerData });
      const booking = await db.bookingRequest.create({
        data: scope.booking(customerData, {
          state: "AWAITING_PAYMENT",
          advanceCents: 10_000,
          depositCents: 20_000,
        }),
      });
      await db.holdedDocument.create({
        data: {
          bookingRequestId: booking.id,
          type: "ESTIMATE",
          holdedId: `${scope.scopeId}-estimate`,
          documentNumber: "EST-PAGE-1001",
          totalCents: 30_000,
          issuedAt: new Date("2026-09-15T00:00:00.000Z"),
        },
      });
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const providerMovement = providerFixtures.movement(account.holdedAccountId, {
        description: "Synthetic transfer EST-PAGE-1001 received",
        amount: "300.00",
      });

      const run = await executeRun(
        account.id,
        syntheticProvider([
          { items: [providerMovement], hasMore: false, cursor: null },
        ]),
      );

      await expect(
        db.bankReconciliationProposal.findFirstOrThrow({
          where: {
            movement: { holdedMovementId: providerMovement.id },
            bookingRequestId: booking.id,
          },
        }),
      ).resolves.toMatchObject({ status: "PENDING" });
      expect(run).toMatchObject({
        status: "SUCCEEDED",
        pageCount: 1,
        insertedCount: 1,
        incidentCount: 0,
      });
    });

    it("serializes concurrent requests and claims into one effective run", async () => {
      const scope = bankingScope("bank-concurrent-run");
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const now = new Date("2026-09-16T12:00:00.000Z");

      const requests = await Promise.all(
        Array.from({ length: 4 }, () =>
          enqueueBankSync({ accountId: account.id, trigger: "MANUAL", now }),
        ),
      );
      const claims = await Promise.all(
        Array.from({ length: 4 }, () => claimNextBankSync(now)),
      );

      expect(new Set(requests.map(({ runId }) => runId))).toEqual(
        new Set([requests[0]!.runId]),
      );
      expect(requests.filter(({ created }) => created)).toHaveLength(1);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await expect(
        db.bankSyncRun.count({ where: { accountId: account.id } }),
      ).resolves.toBe(1);
    });

    it("reclaims an expired lease and rejects writes from the prior owner", async () => {
      const scope = bankingScope("bank-lease-reclaim");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const claimedAt = new Date("2026-09-16T12:00:00.000Z");
      const { runId } = await enqueueBankSync({
        accountId: account.id,
        trigger: "MANUAL",
        now: claimedAt,
      });
      const firstLease = await claimNextBankSync(claimedAt);
      if (!firstLease) throw new Error("Expected the first lease");
      const reclaimedAt = new Date(claimedAt.getTime() + BANK_SYNC_LEASE_MS + 1);

      await expect(claimNextBankSync(reclaimedAt)).resolves.toMatchObject({
        runId,
        leaseToken: expect.not.stringMatching(firstLease.leaseToken),
      });
      const movement = providerFixtures.movement(account.holdedAccountId);
      await expect(
        processBankSync(firstLease, {
          provider: syntheticProvider([
            { items: [movement], hasMore: false, cursor: null },
          ]),
          now: () => reclaimedAt,
        }),
      ).rejects.toThrow(/lease/u);
      await expect(
        db.bankMovement.count({ where: { accountId: account.id } }),
      ).resolves.toBe(0);
    });

    it("renews heartbeat and lease ownership after every committed page", async () => {
      const scope = bankingScope("bank-heartbeat");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const claimedAt = new Date("2026-09-16T12:00:00.000Z");
      const firstPageAt = new Date("2026-09-16T12:01:00.000Z");
      const secondPageAt = new Date("2026-09-16T12:01:30.000Z");
      await enqueueBankSync({ accountId: account.id, trigger: "MANUAL", now: claimedAt });
      const lease = await claimNextBankSync(claimedAt);
      if (!lease) throw new Error("Expected a bank synchronization lease");
      let providerCall = 0;
      const provider: BankMovementProvider = {
        listBankMovements: vi.fn(async () => {
          providerCall += 1;
          if (providerCall === 1) {
            return {
              items: [providerFixtures.movement(account.holdedAccountId)],
              hasMore: true,
              cursor: "heartbeat-next",
            };
          }
          const afterFirstPage = await db.bankSyncRun.findUniqueOrThrow({
            where: { id: lease.runId },
          });
          expect(afterFirstPage).toMatchObject({
            status: "RUNNING",
            heartbeatAt: firstPageAt,
            leaseToken: lease.leaseToken,
            leaseExpiresAt: new Date(firstPageAt.getTime() + BANK_SYNC_LEASE_MS),
          });
          return { items: [], hasMore: false, cursor: null };
        }),
      };
      const pageTimes = [firstPageAt, secondPageAt];

      await processBankSync(lease, {
        provider,
        now: () => pageTimes.shift() ?? secondPageAt,
      });

      await expect(
        db.bankSyncRun.findUniqueOrThrow({ where: { id: lease.runId } }),
      ).resolves.toMatchObject({
        status: "SUCCEEDED",
        heartbeatAt: secondPageAt,
        leaseToken: null,
        leaseExpiresAt: null,
      });
    });

    it("backs off transient failures and stops after six attempts without deleting rows", async () => {
      const scope = bankingScope("bank-retry-exhaustion");
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const retained = scope.movement(accountData);
      await db.bankMovement.create({ data: retained });
      let attemptAt = new Date("2026-09-16T12:00:00.000Z");
      const { runId } = await enqueueBankSync({
        accountId: account.id,
        trigger: "MANUAL",
        now: attemptAt,
      });
      const provider: BankMovementProvider = {
        listBankMovements: vi.fn(async () => {
          throw new HoldedError("unavailable", "synthetic outage");
        }),
      };

      for (let attempt = 1; attempt <= BANK_SYNC_MAX_ATTEMPTS; attempt += 1) {
        const lease = await claimNextBankSync(attemptAt);
        if (!lease) throw new Error(`Expected retry lease ${attempt}`);
        await expect(
          processBankSync(lease, { provider, now: () => attemptAt }),
        ).rejects.toBeInstanceOf(HoldedError);
        const run = await db.bankSyncRun.findUniqueOrThrow({ where: { id: runId } });
        expect(run.attemptCount).toBe(attempt);
        expect(run.failureCode).toBe("PROVIDER_UNAVAILABLE");
        if (attempt < BANK_SYNC_MAX_ATTEMPTS) {
          const delay = Math.min(
            BANK_SYNC_INITIAL_RETRY_MS * 2 ** (attempt - 1),
            BANK_SYNC_MAX_RETRY_MS,
          );
          expect(run).toMatchObject({
            status: "RETRYING",
            nextAttemptAt: new Date(attemptAt.getTime() + delay),
            leaseToken: null,
            leaseExpiresAt: null,
          });
          attemptAt = run.nextAttemptAt;
        } else {
          expect(run).toMatchObject({ status: "FAILED", finishedAt: attemptAt });
        }
      }

      await expect(claimNextBankSync(attemptAt)).resolves.toBeNull();
      await expect(
        db.bankMovement.findUniqueOrThrow({ where: { id: retained.id } }),
      ).resolves.toMatchObject({ id: retained.id });
    });

    it("marks a malformed first page failed and a later malformed page partial", async () => {
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const firstScope = bankingScope("bank-failed-page");
      const firstData = firstScope.treasuryAccount({ active: false });
      const firstAccount = await db.holdedTreasuryAccount.create({ data: firstData });
      const failed = await enqueueBankSync({
        accountId: firstAccount.id,
        trigger: "MANUAL",
      });
      const failedLease = await claimNextBankSync();
      if (!failedLease) throw new Error("Expected failed-run lease");
      await expect(
        processBankSync(failedLease, {
          provider: syntheticProvider([
            { items: [], hasMore: true, cursor: null },
          ]),
        }),
      ).rejects.toThrow();
      await expect(
        db.bankSyncRun.findUniqueOrThrow({ where: { id: failed.runId } }),
      ).resolves.toMatchObject({
        status: "FAILED",
        pageCount: 0,
        failureCode: "MISSING_CURSOR",
      });

      const secondScope = bankingScope("bank-partial-page");
      const secondData = secondScope.treasuryAccount({ active: true });
      const secondAccount = await db.holdedTreasuryAccount.create({ data: secondData });
      const partial = await enqueueBankSync({
        accountId: secondAccount.id,
        trigger: "MANUAL",
      });
      const partialLease = await claimNextBankSync();
      if (!partialLease) throw new Error("Expected partial-run lease");
      const retainedMovement = providerFixtures.movement(
        secondAccount.holdedAccountId,
      );
      await expect(
        processBankSync(partialLease, {
          provider: syntheticProvider([
            {
              items: [retainedMovement],
              hasMore: true,
              cursor: "partial-next",
            },
            { items: [], hasMore: true, cursor: null },
          ]),
        }),
      ).rejects.toThrow();
      await expect(
        db.bankSyncRun.findUniqueOrThrow({ where: { id: partial.runId } }),
      ).resolves.toMatchObject({
        status: "PARTIAL",
        pageCount: 1,
        nextCursor: "partial-next",
        failureCode: "MISSING_CURSOR",
      });
      await expect(
        db.bankMovement.count({ where: { accountId: secondAccount.id } }),
      ).resolves.toBe(1);
    });

    it("rejects a repeated cursor without advancing beyond the committed page", async () => {
      const scope = bankingScope("bank-repeated-cursor");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const { runId } = await enqueueBankSync({
        accountId: account.id,
        trigger: "MANUAL",
      });
      const lease = await claimNextBankSync();
      if (!lease) throw new Error("Expected repeated-cursor lease");

      await expect(
        processBankSync(lease, {
          provider: syntheticProvider([
            {
              items: [providerFixtures.movement(account.holdedAccountId)],
              hasMore: true,
              cursor: "same-cursor",
            },
            { items: [], hasMore: true, cursor: "same-cursor" },
          ]),
        }),
      ).rejects.toThrow();

      await expect(
        db.bankSyncRun.findUniqueOrThrow({ where: { id: runId } }),
      ).resolves.toMatchObject({
        status: "PARTIAL",
        pageCount: 1,
        nextCursor: "same-cursor",
        failureCode: "REPEATED_CURSOR",
      });
    });

    it("continues after an empty nonterminal page", async () => {
      const scope = bankingScope("bank-empty-page");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const run = await executeRun(
        account.id,
        syntheticProvider([
          { items: [], hasMore: true, cursor: "after-empty" },
          {
            items: [providerFixtures.movement(account.holdedAccountId)],
            hasMore: false,
            cursor: null,
          },
        ]),
      );

      expect(run).toMatchObject({
        status: "SUCCEEDED",
        pageCount: 2,
        itemCount: 1,
        insertedCount: 1,
      });
    });

    it("links a manual retry and restarts a rejected stale cursor from the effective floor", async () => {
      const scope = bankingScope("bank-stale-cursor");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount({
        importStartDate: new Date("2026-01-01T00:00:00.000Z"),
        retentionFloorDate: new Date("2026-06-18T00:00:00.000Z"),
      });
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const prior = await db.bankSyncRun.create({
        data: {
          ...scope.run(accountData, {
            status: "PARTIAL",
            nextCursor: "stale-provider-cursor",
            finishedAt: new Date("2026-09-16T11:00:00.000Z"),
          }),
          windowStartDate: account.retentionFloorDate!,
          pageCount: 1,
        },
      });
      const retried = await enqueueBankSync({
        accountId: account.id,
        trigger: "MANUAL",
        resumedFromRunId: prior.id,
        now: new Date("2026-09-16T12:00:00.000Z"),
      });
      const lease = await claimNextBankSync(
        new Date("2026-09-16T12:00:00.000Z"),
      );
      if (!lease) throw new Error("Expected linked retry lease");
      const movement = providerFixtures.movement(account.holdedAccountId);
      const listBankMovements = vi
        .fn<BankMovementProvider["listBankMovements"]>()
        .mockRejectedValueOnce(
          new HoldedError("invalid_request", "synthetic stale cursor"),
        )
        .mockResolvedValueOnce({
          items: [movement],
          hasMore: false,
          cursor: null,
        });

      await processBankSync(lease, {
        provider: { listBankMovements },
        now: () => new Date("2026-09-16T12:00:30.000Z"),
      });

      await expect(
        db.bankSyncRun.findUniqueOrThrow({ where: { id: retried.runId } }),
      ).resolves.toMatchObject({
        status: "SUCCEEDED",
        resumedFromRunId: prior.id,
        windowStartDate: account.retentionFloorDate,
        nextCursor: null,
      });
      expect(listBankMovements).toHaveBeenNthCalledWith(1, {
        accountId: account.holdedAccountId,
        startDate: "2026-06-18",
        cursor: "stale-provider-cursor",
      });
      expect(listBankMovements).toHaveBeenNthCalledWith(2, {
        accountId: account.holdedAccountId,
        startDate: "2026-06-18",
        cursor: undefined,
      });
    });

    it("returns one active manual run and enforces a one-minute database cooldown", async () => {
      const scope = bankingScope("bank-manual-cooldown");
      const actor = await db.user.create({ data: scope.user() });
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const requestedAt = new Date("2026-09-16T12:00:00.000Z");

      const first = await requestManualBankSync({
        requestedById: actor.id,
        now: requestedAt,
      });
      await expect(
        requestManualBankSync({
          requestedById: actor.id,
          now: new Date(requestedAt.getTime() + 1_000),
        }),
      ).resolves.toEqual({ ...first, created: false });

      await db.bankSyncRun.update({
        where: { id: first.runId },
        data: { status: "SUCCEEDED", finishedAt: requestedAt },
      });
      await expect(
        requestManualBankSync({
          requestedById: actor.id,
          now: new Date(
            requestedAt.getTime() + BANK_SYNC_MANUAL_COOLDOWN_MS - 1,
          ),
        }),
      ).rejects.toMatchObject({ code: "rate_limited" });

      await expect(
        requestManualBankSync({
          requestedById: actor.id,
          now: new Date(requestedAt.getTime() + BANK_SYNC_MANUAL_COOLDOWN_MS),
        }),
      ).resolves.toMatchObject({
        created: true,
        accountId: account.id,
      });
    });

    it("makes a normal manual movement visible within two minutes of acceptance", async () => {
      const scope = bankingScope("bank-manual-visibility");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const actor = await db.user.create({ data: scope.user() });
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const requestedAt = new Date("2026-09-16T12:00:00.000Z");
      const processedAt = new Date("2026-09-16T12:01:00.000Z");
      const providerMovement = providerFixtures.movement(account.holdedAccountId, {
        description: "Synthetic visible manual movement",
      });
      const request = await requestManualBankSync({
        requestedById: actor.id,
        now: requestedAt,
      });
      const lease = await claimNextBankSync(processedAt);
      expect(lease?.runId).toBe(request.runId);
      if (!lease) throw new Error("Expected accepted manual run lease");

      await processBankSync(lease, {
        provider: syntheticProvider([
          { items: [providerMovement], hasMore: false, cursor: null },
        ]),
        now: () => processedAt,
      });
      const projection = await queryBankMovements(
        movementFilters({ account: account.holdedAccountId }),
      );

      expect(processedAt.getTime() - requestedAt.getTime()).toBeLessThan(120_000);
      expect(projection.rows).toEqual([
        expect.objectContaining({
          concept: "Synthetic visible manual movement",
          account: expect.objectContaining({ id: account.holdedAccountId }),
        }),
      ]);
    });

    it("rolls back a page before advancing its cursor", async () => {
      const scope = bankingScope("bank-rollback");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const movement = providerFixtures.movement(account.holdedAccountId);
      const provider = syntheticProvider([
        { items: [movement], hasMore: true, cursor: "must-not-commit" },
      ]);
      const enqueued = await enqueueBankSync({
        accountId: account.id,
        trigger: "MANUAL",
        now: new Date("2026-09-16T12:00:00.000Z"),
      });
      const lease = await claimNextBankSync(
        new Date("2026-09-16T12:00:00.000Z"),
      );
      if (!lease) throw new Error("Expected a bank synchronization lease");

      const suffix = randomUUID().replaceAll("-", "");
      const functionName = quoteIdentifier(`reject_bank_page_${suffix}`);
      const triggerName = quoteIdentifier(`reject_bank_page_trigger_${suffix}`);
      await db.$executeRawUnsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'synthetic page rollback';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON "BankMovement"
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);

      try {
        await expect(
          processBankSync(lease, {
            provider,
            now: () => new Date("2026-09-16T12:00:00.000Z"),
          }),
        ).rejects.toThrow();
      } finally {
        await db.$executeRawUnsafe(`
          DROP TRIGGER IF EXISTS ${triggerName} ON "BankMovement";
          DROP FUNCTION IF EXISTS ${functionName}();
        `);
      }

      await expect(
        db.bankMovement.count({ where: { accountId: account.id } }),
      ).resolves.toBe(0);
      await expect(
        db.bankSyncRun.findUniqueOrThrow({ where: { id: enqueued.runId } }),
      ).resolves.toMatchObject({
        pageCount: 0,
        itemCount: 0,
        insertedCount: 0,
        incidentCount: 0,
        nextCursor: null,
      });
    });

    it("is idempotent and updates provider corrections in place", async () => {
      const scope = bankingScope("bank-repeat");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const original = providerFixtures.movement(account.holdedAccountId, {
        description: "Original synthetic description",
        amount: "125.50",
        status: "pending",
      });

      const firstRun = await executeRun(
        account.id,
        syntheticProvider([{ items: [original], hasMore: false, cursor: null }]),
        new Date("2026-09-16T12:00:00.000Z"),
      );
      const stored = await db.bankMovement.findFirstOrThrow({
        where: { accountId: account.id, holdedMovementId: original.id },
      });

      const repeatRun = await executeRun(
        account.id,
        syntheticProvider([{ items: [original], hasMore: false, cursor: null }]),
        new Date("2026-09-16T13:00:00.000Z"),
      );
      expect(repeatRun).toMatchObject({
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 1,
      });

      const corrected = {
        ...original,
        description: "Corrected synthetic description",
        amount: "130.00",
        status: "reconciled",
      };
      const correctionRun = await executeRun(
        account.id,
        syntheticProvider([{ items: [corrected], hasMore: false, cursor: null }]),
        new Date("2026-09-16T14:00:00.000Z"),
      );
      const afterCorrection = await db.bankMovement.findFirstOrThrow({
        where: { accountId: account.id, holdedMovementId: original.id },
      });

      expect(firstRun.insertedCount).toBe(1);
      expect(correctionRun).toMatchObject({
        insertedCount: 0,
        updatedCount: 1,
        unchangedCount: 0,
      });
      expect(afterCorrection).toMatchObject({
        id: stored.id,
        firstSeenAt: stored.firstSeenAt,
        narrative: corrected.description,
        amountMinor: BigInt(13_000),
        providerStatus: "reconciled",
      });
      await expect(
        db.bankMovement.count({ where: { accountId: account.id } }),
      ).resolves.toBe(1);
    });

    it("commits valid items and sanitized incidents from the same page", async () => {
      const scope = bankingScope("bank-mixed");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const accountData = scope.treasuryAccount();
      const account = await db.holdedTreasuryAccount.create({ data: accountData });
      const income = providerFixtures.movement(account.holdedAccountId, {
        amount: "25.00",
        description: "expense debit words do not matter",
      });
      const expense = providerFixtures.movement(account.holdedAccountId, {
        amount: "-10.00",
        description: "income credit words do not matter",
      });
      const zero = providerFixtures.movement(account.holdedAccountId, {
        amount: "0.00",
      });
      const nonEur = providerFixtures.movement(account.holdedAccountId, {
        currency: "USD",
      });
      const invalidId = providerFixtures.movement(account.holdedAccountId, {
        id: "invalid-id",
      });
      const mismatch = providerFixtures.movement("ffffffffffffffffffffffff");

      const run = await executeRun(
        account.id,
        syntheticProvider([
          {
            items: [zero, income, nonEur, invalidId, expense, mismatch],
            hasMore: false,
            cursor: null,
          },
        ]),
      );

      expect(run).toMatchObject({
        status: "PARTIAL",
        pageCount: 1,
        itemCount: 6,
        insertedCount: 2,
        updatedCount: 0,
        unchangedCount: 0,
        incidentCount: 4,
      });
      expect(run.exhaustedAt).not.toBeNull();
      await expect(
        db.bankMovement.findMany({
          where: { accountId: account.id },
          orderBy: { amountMinor: "desc" },
          select: { amountMinor: true, direction: true },
        }),
      ).resolves.toEqual([
        { amountMinor: BigInt(2_500), direction: "INCOME" },
        { amountMinor: BigInt(-1_000), direction: "EXPENSE" },
      ]);
      const incidents = await db.bankSyncIncident.findMany({
        where: { runId: run.id },
        orderBy: { itemIndex: "asc" },
      });
      expect(incidents.map(({ code, itemIndex, holdedMovementId }) => ({
        code,
        itemIndex,
        holdedMovementId,
      }))).toEqual([
        { code: "ZERO_AMOUNT", itemIndex: 0, holdedMovementId: zero.id },
        { code: "INVALID_CURRENCY", itemIndex: 2, holdedMovementId: nonEur.id },
        { code: "INVALID_MOVEMENT_ID", itemIndex: 3, holdedMovementId: null },
        { code: "ACCOUNT_MISMATCH", itemIndex: 5, holdedMovementId: mismatch.id },
      ]);
    });

    it("creates one due run and advances the schedule by six hours", async () => {
      const scope = bankingScope("bank-due");
      const due = new Date("2026-09-16T12:00:00.000Z");
      const accountData = scope.treasuryAccount({
        nextScheduledAt: new Date("2026-09-16T11:59:00.000Z"),
      });
      const account = await db.holdedTreasuryAccount.create({ data: accountData });

      await expect(enqueueDueBankSyncRuns(due)).resolves.toBe(1);
      await expect(enqueueDueBankSyncRuns(due)).resolves.toBe(0);

      await expect(
        db.holdedTreasuryAccount.findUniqueOrThrow({ where: { id: account.id } }),
      ).resolves.toMatchObject({
        nextScheduledAt: new Date("2026-09-16T18:00:00.000Z"),
      });
      await expect(
        db.bankSyncRun.findMany({ where: { accountId: account.id } }),
      ).resolves.toMatchObject([{ trigger: "SCHEDULED", status: "QUEUED" }]);
      expect(providerMocks.listTreasuryAccounts).not.toHaveBeenCalled();
    });

    it("keeps equal provider movement identifiers distinct across account history", async () => {
      const scope = bankingScope("bank-scope");
      const providerFixtures = createHoldedTreasuryFixtureScope();
      const firstData = scope.treasuryAccount({ active: true });
      const first = await db.holdedTreasuryAccount.create({ data: firstData });
      const sharedId = "eeeeeeeeeeeeeeeeeeeeeeee";
      await executeRun(
        first.id,
        syntheticProvider([
          {
            items: [
              providerFixtures.movement(first.holdedAccountId, { id: sharedId }),
            ],
            hasMore: false,
            cursor: null,
          },
        ]),
      );

      await db.holdedTreasuryAccount.update({
        where: { id: first.id },
        data: { active: false },
      });
      const secondData = scope.treasuryAccount({ active: true });
      const second = await db.holdedTreasuryAccount.create({ data: secondData });
      await executeRun(
        second.id,
        syntheticProvider([
          {
            items: [
              providerFixtures.movement(second.holdedAccountId, { id: sharedId }),
            ],
            hasMore: false,
            cursor: null,
          },
        ]),
      );

      await expect(
        db.bankMovement.findMany({
          where: { holdedMovementId: sharedId },
          orderBy: { accountId: "asc" },
          select: { accountId: true },
        }),
      ).resolves.toEqual(
        [{ accountId: first.id }, { accountId: second.id }].toSorted((left, right) =>
          left.accountId.localeCompare(right.accountId),
        ),
      );
    });
  },
);