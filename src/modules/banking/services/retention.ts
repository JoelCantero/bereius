import "server-only";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { BANK_RETENTION_DAYS } from "@/modules/banking/schema";

export const BANK_RETENTION_MOVEMENT_BATCH_SIZE = 500;
export const BANK_RETENTION_RUN_BATCH_SIZE = 500;

export interface BankRetentionSummary {
  accountsAdvanced: number;
  movementsDeleted: number;
  proposalsDeleted: number;
  runsDeleted: number;
}

interface BankRetentionOptions {
  movementBatchSize?: number;
  runBatchSize?: number;
}

function boundedSize(value: number | undefined, fallback: number) {
  if (!value || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, fallback);
}

function retentionFloorAt(now: Date) {
  const floor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  floor.setUTCDate(floor.getUTCDate() - BANK_RETENTION_DAYS);
  return floor;
}

function historyCutoffAt(now: Date) {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - BANK_RETENTION_DAYS);
  return cutoff;
}

export async function runBankRetention(
  now = new Date(),
  options: BankRetentionOptions = {},
): Promise<BankRetentionSummary> {
  const movementBatchSize = boundedSize(
    options.movementBatchSize,
    BANK_RETENTION_MOVEMENT_BATCH_SIZE,
  );
  const runBatchSize = boundedSize(
    options.runBatchSize,
    BANK_RETENTION_RUN_BATCH_SIZE,
  );
  const candidateFloor = retentionFloorAt(now);
  const accountIds = await db.holdedTreasuryAccount.findMany({
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const summary: BankRetentionSummary = {
    accountsAdvanced: 0,
    movementsDeleted: 0,
    proposalsDeleted: 0,
    runsDeleted: 0,
  };

  for (const { id: accountId } of accountIds) {
    const accountResult = await db.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
        FROM "HoldedTreasuryAccount"
        WHERE "id" = ${accountId}
        FOR UPDATE
      `;
      const account = await transaction.holdedTreasuryAccount.findUnique({
        where: { id: accountId },
        select: {
          importStartDate: true,
          retentionFloorDate: true,
        },
      });
      if (!account) {
        return { advanced: 0, movementsDeleted: 0, proposalsDeleted: 0 };
      }

      let effectiveFloor = account.retentionFloorDate;
      let advanced = 0;
      if (!effectiveFloor || candidateFloor > effectiveFloor) {
        const requiredWindowStart =
          account.retentionFloorDate ?? account.importStartDate;
        const authorizingRun = await transaction.bankSyncRun.findFirst({
          where: {
            accountId,
            status: { in: ["SUCCEEDED", "PARTIAL"] },
            exhaustedAt: { not: null, lte: now },
            windowStartDate: { lte: requiredWindowStart },
          },
          orderBy: [{ exhaustedAt: "desc" }, { id: "desc" }],
          select: { id: true },
        });
        if (!authorizingRun) {
          return { advanced: 0, movementsDeleted: 0, proposalsDeleted: 0 };
        }

        await transaction.holdedTreasuryAccount.update({
          where: { id: accountId },
          data: { retentionFloorDate: candidateFloor },
        });
        effectiveFloor = candidateFloor;
        advanced = 1;
      }

      if (!effectiveFloor) {
        return { advanced, movementsDeleted: 0, proposalsDeleted: 0 };
      }

      const deletableMovements = await transaction.bankMovement.findMany({
        where: {
          accountId,
          bookingDate: { lt: effectiveFloor },
          payment: null,
          proposals: {
            none: { status: { in: ["PENDING", "CONFIRMED"] } },
          },
        },
        orderBy: [{ bookingDate: "asc" }, { id: "asc" }],
        take: movementBatchSize,
        select: { id: true },
      });
      const movementIds = deletableMovements.map(({ id }) => id);
      if (movementIds.length === 0) {
        return { advanced, movementsDeleted: 0, proposalsDeleted: 0 };
      }

      const proposals = await transaction.bankReconciliationProposal.deleteMany({
        where: {
          movementId: { in: movementIds },
          status: { in: ["DISMISSED", "INVALIDATED"] },
        },
      });
      const movements = await transaction.bankMovement.deleteMany({
        where: { id: { in: movementIds } },
      });
      return {
        advanced,
        movementsDeleted: movements.count,
        proposalsDeleted: proposals.count,
      };
    });

    summary.accountsAdvanced += accountResult.advanced;
    summary.movementsDeleted += accountResult.movementsDeleted;
    summary.proposalsDeleted += accountResult.proposalsDeleted;
  }

  summary.runsDeleted = await db.$transaction(async (transaction) => {
    const oldRuns = await transaction.bankSyncRun.findMany({
      where: {
        status: { in: ["SUCCEEDED", "PARTIAL", "FAILED"] },
        finishedAt: { lt: historyCutoffAt(now) },
      },
      orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
      take: runBatchSize,
      select: { id: true },
    });
    if (oldRuns.length === 0) return 0;
    const deleted = await transaction.bankSyncRun.deleteMany({
      where: { id: { in: oldRuns.map(({ id }) => id) } },
    });
    return deleted.count;
  });

  logger.info(
    { event: "bank_retention_completed", ...summary },
    "bank retention completed",
  );
  return summary;
}