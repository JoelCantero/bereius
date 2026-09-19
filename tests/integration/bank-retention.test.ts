// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";
import {
  claimBankSyncRun,
  enqueueBankSync,
  processBankSync,
} from "@/modules/banking/services/synchronization";
import { runBankRetention } from "@/modules/banking/services/retention";
import { createBankingFixtureScope } from "../helpers/banking";
import { createHoldedTreasuryFixtureScope } from "../helpers/holded-treasury";

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";
const scopes = new Set<ReturnType<typeof createBankingFixtureScope>>();
const now = new Date("2026-09-16T12:00:00.000Z");
const expectedFloor = new Date("2026-06-18T00:00:00.000Z");

function fixtureScope(label: string) {
  const scope = createBankingFixtureScope(label);
  scopes.add(scope);
  return scope;
}

async function accountContext(label: string) {
  const scope = fixtureScope(label);
  const accountData = scope.treasuryAccount({
    importStartDate: new Date("2026-01-01T00:00:00.000Z"),
  });
  const account = await db.holdedTreasuryAccount.create({ data: accountData });
  return { scope, accountData, account };
}

async function exhaustedRun(
  context: Awaited<ReturnType<typeof accountContext>>,
  status: "SUCCEEDED" | "PARTIAL" = "SUCCEEDED",
) {
  return db.bankSyncRun.create({
    data: {
      ...context.scope.run(context.accountData, {
        status,
        exhaustedAt: now,
        finishedAt: now,
      }),
      startedAt: now,
      ...(status === "PARTIAL" ? { incidentCount: 1 } : {}),
    },
  });
}

describe.skipIf(!runIntegrationTests)("bank retention", () => {
  afterEach(async () => {
    await Promise.all(
      [...scopes].map(async (scope) => {
        await scope.cleanup();
        scopes.delete(scope);
      }),
    );
  });

  it("preserves first-run history until an exhausted scan authorizes a floor", async () => {
    const context = await accountContext("bank-retention-first-run");
    const movement = await db.bankMovement.create({
      data: context.scope.movement(context.accountData, {
        bookingDate: new Date("2025-12-01T00:00:00.000Z"),
      }),
    });

    await runBankRetention(now);

    await expect(
      db.holdedTreasuryAccount.findUniqueOrThrow({
        where: { id: context.account.id },
        select: { retentionFloorDate: true },
      }),
    ).resolves.toEqual({ retentionFloorDate: null });
    await expect(
      db.bankMovement.count({ where: { id: movement.id } }),
    ).resolves.toBe(1);
  });

  it("advances the floor monotonically after a clean exhausted run", async () => {
    const context = await accountContext("bank-retention-clean-floor");
    await exhaustedRun(context);

    await runBankRetention(now);
    await runBankRetention(new Date("2026-08-01T12:00:00.000Z"));

    await expect(
      db.holdedTreasuryAccount.findUniqueOrThrow({
        where: { id: context.account.id },
        select: { retentionFloorDate: true },
      }),
    ).resolves.toEqual({ retentionFloorDate: expectedFloor });
  });

  it("allows an exhausted incident-only PARTIAL run to advance the floor", async () => {
    const context = await accountContext("bank-retention-incident-partial");
    const run = await exhaustedRun(context, "PARTIAL");
    await db.bankSyncIncident.create({
      data: {
        runId: run.id,
        code: "ZERO_AMOUNT",
        pageNumber: 1,
        itemIndex: 0,
      },
    });

    await runBankRetention(now);

    await expect(
      db.holdedTreasuryAccount.findUniqueOrThrow({
        where: { id: context.account.id },
        select: { retentionFloorDate: true },
      }),
    ).resolves.toEqual({ retentionFloorDate: expectedFloor });
  });

  it.each(["PARTIAL", "FAILED"] as const)(
    "does not advance from an incomplete %s run",
    async (status) => {
      const context = await accountContext(
        `bank-retention-incomplete-${status.toLowerCase()}`,
      );
      await db.bankSyncRun.create({
        data: {
          ...context.scope.run(context.accountData, {
            status,
            finishedAt: now,
          }),
          startedAt: now,
        },
      });

      await runBankRetention(now);

      await expect(
        db.holdedTreasuryAccount.findUniqueOrThrow({
          where: { id: context.account.id },
          select: { retentionFloorDate: true },
        }),
      ).resolves.toEqual({ retentionFloorDate: null });
    },
  );

  it("deletes old unmatched movements and terminal proposals in bounded batches", async () => {
    const context = await accountContext("bank-retention-bounded");
    await exhaustedRun(context);
    const customer = await db.customer.create({ data: context.scope.customer() });
    const booking = await db.bookingRequest.create({
      data: context.scope.booking(customer),
    });
    const movements = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const movement = await db.bankMovement.create({
          data: context.scope.movement(context.accountData, {
            bookingDate: new Date("2026-06-01T00:00:00.000Z"),
          }),
        });
        await db.bankReconciliationProposal.create({
          data: {
            movementId: movement.id,
            bookingRequestId: booking.id,
            status: index % 2 === 0 ? "DISMISSED" : "INVALIDATED",
          },
        });
        return movement;
      }),
    );

    const first = await runBankRetention(now, { movementBatchSize: 2 });

    expect(first).toMatchObject({ movementsDeleted: 2, proposalsDeleted: 2 });
    await expect(
      db.bankMovement.count({
        where: { id: { in: movements.map(({ id }) => id) } },
      }),
    ).resolves.toBe(1);

    const second = await runBankRetention(now, { movementBatchSize: 2 });
    expect(second).toMatchObject({ movementsDeleted: 1, proposalsDeleted: 1 });
    await expect(
      db.bankMovement.count({
        where: { id: { in: movements.map(({ id }) => id) } },
      }),
    ).resolves.toBe(0);
  });

  it("protects payment-linked and pending or confirmed proposal evidence", async () => {
    const context = await accountContext("bank-retention-protected");
    await exhaustedRun(context);
    const customer = await db.customer.create({ data: context.scope.customer() });
    const booking = await db.bookingRequest.create({
      data: context.scope.booking(customer),
    });
    const protectedMovements = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        db.bankMovement.create({
          data: context.scope.movement(context.accountData, {
            bookingDate: new Date("2026-06-01T00:00:00.000Z"),
            holdedMovementId: (index + 1).toString(16).padStart(24, "0"),
          }),
        }),
      ),
    );
    await db.payment.create({
      data: {
        bookingRequestId: booking.id,
        amountCents: 12_550,
        receivedAt: now,
        bankMovementId: protectedMovements[0]!.id,
      },
    });
    await db.bankReconciliationProposal.createMany({
      data: [
        {
          movementId: protectedMovements[1]!.id,
          bookingRequestId: booking.id,
          status: "PENDING",
        },
        {
          movementId: protectedMovements[2]!.id,
          bookingRequestId: booking.id,
          status: "CONFIRMED",
        },
      ],
    });

    await runBankRetention(now);

    await expect(
      db.bankMovement.count({
        where: { id: { in: protectedMovements.map(({ id }) => id) } },
      }),
    ).resolves.toBe(3);
  });

  it("prunes old terminal run history and incidents in a separate bounded batch", async () => {
    const context = await accountContext("bank-retention-run-history");
    const old = new Date("2026-06-17T11:59:59.999Z");
    const oldRuns = [];
    for (const status of ["SUCCEEDED", "PARTIAL", "FAILED"] as const) {
      oldRuns.push(
        await db.bankSyncRun.create({
          data: {
            ...context.scope.run(context.accountData, {
              status,
              exhaustedAt: status === "FAILED" ? null : old,
              finishedAt: old,
            }),
            startedAt: old,
            createdAt: old,
          },
        }),
      );
    }
    await db.bankSyncIncident.createMany({
      data: oldRuns.map((run) => ({
        runId: run.id,
        code: "ZERO_AMOUNT" as const,
        pageNumber: 1,
        itemIndex: 0,
      })),
    });
    const resumed = await db.bankSyncRun.create({
      data: {
        ...context.scope.run(context.accountData, {
          status: "SUCCEEDED",
          exhaustedAt: now,
          finishedAt: now,
        }),
        startedAt: now,
        resumedFromRunId: oldRuns[0]!.id,
      },
    });

    const first = await runBankRetention(now, { runBatchSize: 2 });
    expect(first.runsDeleted).toBe(2);
    await expect(
      db.bankSyncRun.count({
        where: { id: { in: oldRuns.map(({ id }) => id) } },
      }),
    ).resolves.toBe(1);

    const second = await runBankRetention(now, { runBatchSize: 2 });
    expect(second.runsDeleted).toBe(1);
    await expect(
      db.bankSyncIncident.count({
        where: { runId: { in: oldRuns.map(({ id }) => id) } },
      }),
    ).resolves.toBe(0);
    await expect(
      db.bankSyncRun.findUniqueOrThrow({
        where: { id: resumed.id },
        select: { resumedFromRunId: true },
      }),
    ).resolves.toEqual({ resumedFromRunId: null });
  });

  it("uses the advanced floor so a pruned movement is not imported again", async () => {
    const context = await accountContext("bank-retention-no-reimport");
    await exhaustedRun(context);
    const providerMovementId = "eeeeeeeeeeeeeeeeeeeeeeee";
    await db.bankMovement.create({
      data: context.scope.movement(context.accountData, {
        holdedMovementId: providerMovementId,
        bookingDate: new Date("2026-06-01T00:00:00.000Z"),
      }),
    });
    await runBankRetention(now);

    const listBankMovements = vi.fn(async (input: { startDate: string }) => ({
      items:
        input.startDate <= "2026-06-01"
          ? [
              createHoldedTreasuryFixtureScope().movement(
                context.accountData.holdedAccountId,
                {
                  id: providerMovementId,
                  booking_date: "2026-06-01T00:00:00Z",
                },
              ),
            ]
          : [],
      hasMore: false,
      cursor: null,
    }));
    const enqueued = await enqueueBankSync({
      accountId: context.account.id,
      trigger: "SCHEDULED",
      now: new Date("2026-09-16T13:00:00.000Z"),
    });
    const lease = await claimBankSyncRun(
      enqueued.runId,
      new Date("2026-09-16T13:00:00.000Z"),
    );
    if (!lease) throw new Error("Expected a retention-floor synchronization lease");
    await processBankSync(lease, {
      provider: { listBankMovements },
      now: () => new Date("2026-09-16T13:00:01.000Z"),
    });

    expect(listBankMovements).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: "2026-06-18" }),
    );
    await expect(
      db.bankMovement.count({
        where: { accountId: context.account.id, holdedMovementId: providerMovementId },
      }),
    ).resolves.toBe(0);
  });
});