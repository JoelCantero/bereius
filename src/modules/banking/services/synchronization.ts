import "server-only";

import { randomUUID } from "node:crypto";

import { db } from "@/lib/db";
import { createHoldedClient, HoldedError } from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import type {
  BankSyncIncidentCode,
  BankSyncTrigger,
  HoldedBankMovementPayload,
} from "@/modules/banking/schema";
import {
  BANK_SYNC_INITIAL_RETRY_MS,
  BANK_SYNC_INTERVAL_MS,
  BANK_SYNC_LEASE_MS,
  BANK_SYNC_MANUAL_COOLDOWN_MS,
  BANK_SYNC_MAX_ATTEMPTS,
  BANK_SYNC_MAX_RETRY_MS,
  BANK_SYNC_NONTERMINAL_STATUSES,
} from "@/modules/banking/schema";
import {
  fullBankSyncWindowStart,
  scheduledBankSyncWindowStart,
} from "@/modules/banking/synchronization-window";
import { parseHoldedBankMovement } from "@/modules/banking/services/movements";
import { reconcileBankMovements } from "@/modules/banking/services/reconciliation";
import { resolveIntegration } from "@/modules/booking/services/settings";

export interface BankMovementPage {
  items: HoldedBankMovementPayload[];
  hasMore: boolean;
  cursor: string | null;
}

export interface BankMovementProvider {
  listBankMovements(input: {
    accountId: string;
    startDate: string;
    cursor?: string;
  }): Promise<BankMovementPage>;
}

export interface BankSyncLease {
  runId: string;
  accountId: string;
  holdedAccountId: string;
  windowStartDate: string;
  nextCursor: string | null;
  leaseToken: string;
  leaseExpiresAt: Date;
}

function bankDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

class BankSyncProcessingError extends Error {
  constructor(readonly code: BankSyncIncidentCode) {
    super(code);
    this.name = "BankSyncProcessingError";
  }
}

function knownFailure(error: unknown): {
  code: BankSyncIncidentCode;
  retryable: boolean;
} | null {
  if (error instanceof BankSyncProcessingError) {
    return { code: error.code, retryable: false };
  }
  if (!(error instanceof HoldedError)) return null;

  switch (error.code) {
    case "unavailable":
      return { code: "PROVIDER_UNAVAILABLE", retryable: true };
    case "rate_limited":
      return { code: "PROVIDER_RATE_LIMITED", retryable: true };
    case "unauthorized":
      return { code: "PROVIDER_UNAUTHORIZED", retryable: false };
    case "not_found":
      return { code: "PROVIDER_NOT_FOUND", retryable: false };
    case "invalid_request":
      return { code: "PROVIDER_REQUEST_REJECTED", retryable: false };
    case "response_too_large":
      return { code: "RESPONSE_TOO_LARGE", retryable: false };
    case "malformed_response":
      return { code: "MALFORMED_PAGE", retryable: false };
  }
}

function assertValidPage(
  page: BankMovementPage,
  seenCursors: ReadonlySet<string>,
) {
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") {
    throw new BankSyncProcessingError("MALFORMED_PAGE");
  }
  if (
    page.hasMore &&
    (typeof page.cursor !== "string" || page.cursor.length === 0)
  ) {
    throw new BankSyncProcessingError("MISSING_CURSOR");
  }
  if (
    !page.hasMore &&
    page.cursor !== null &&
    typeof page.cursor !== "string"
  ) {
    throw new BankSyncProcessingError("MALFORMED_PAGE");
  }
  if (page.hasMore && page.cursor && seenCursors.has(page.cursor)) {
    throw new BankSyncProcessingError("REPEATED_CURSOR");
  }
}

async function transitionAfterKnownFailure(
  lease: BankSyncLease,
  failure: { code: BankSyncIncidentCode; retryable: boolean },
  failedAt: Date,
) {
  const outcome = await db.$transaction(async (transaction) => {
    const run = await transaction.bankSyncRun.findUnique({
      where: { id: lease.runId },
      select: {
        status: true,
        pageCount: true,
        attemptCount: true,
        leaseToken: true,
        leaseExpiresAt: true,
      },
    });
    if (
      !run ||
      run.status !== "RUNNING" ||
      run.leaseToken !== lease.leaseToken ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= failedAt
    ) {
      return null;
    }

    const retrying =
      failure.retryable && run.attemptCount < BANK_SYNC_MAX_ATTEMPTS;
    const status = retrying
      ? "RETRYING"
      : run.pageCount > 0
        ? "PARTIAL"
        : "FAILED";
    const retryDelay = Math.min(
      BANK_SYNC_INITIAL_RETRY_MS * 2 ** Math.max(0, run.attemptCount - 1),
      BANK_SYNC_MAX_RETRY_MS,
    );
    const updated = await transaction.bankSyncRun.updateMany({
      where: {
        id: lease.runId,
        status: "RUNNING",
        leaseToken: lease.leaseToken,
        leaseExpiresAt: { gt: failedAt },
      },
      data: {
        status,
        failureCode: failure.code,
        nextAttemptAt: retrying
          ? new Date(failedAt.getTime() + retryDelay)
          : failedAt,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: failedAt,
        finishedAt: retrying ? null : failedAt,
      },
    });
    return updated.count === 1 ? status : null;
  });

  if (outcome) {
    logger.warn(
      {
        event: "bank_sync_attempt_failed",
        runId: lease.runId,
        accountId: lease.accountId,
        code: failure.code,
        status: outcome,
      },
      "bank synchronization attempt failed",
    );
  }
}

async function restartRejectedCursor(lease: BankSyncLease, restartedAt: Date) {
  const restarted = await db.bankSyncRun.updateMany({
    where: {
      id: lease.runId,
      status: "RUNNING",
      leaseToken: lease.leaseToken,
      leaseExpiresAt: { gt: restartedAt },
    },
    data: {
      nextCursor: null,
      heartbeatAt: restartedAt,
      leaseExpiresAt: new Date(restartedAt.getTime() + BANK_SYNC_LEASE_MS),
    },
  });
  if (restarted.count !== 1) {
    throw new Error("Bank synchronization lease was lost");
  }
}

export class BankSyncRequestError extends Error {
  constructor(readonly code: "not_configured" | "rate_limited" | "invalid") {
    super(code);
    this.name = "BankSyncRequestError";
  }
}

export async function enqueueBankSync(input: {
  accountId: string;
  trigger: BankSyncTrigger;
  requestedById?: string | null;
  resumedFromRunId?: string | null;
  now?: Date;
}): Promise<{ runId: string; created: boolean }> {
  const now = input.now ?? new Date();

  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bank-sync:' + input.accountId}))`;

    const existingRun = await transaction.bankSyncRun.findFirst({
      where: {
        accountId: input.accountId,
        status: { in: [...BANK_SYNC_NONTERMINAL_STATUSES] },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (existingRun) return { runId: existingRun.id, created: false };

    const account = await transaction.holdedTreasuryAccount.findUniqueOrThrow({
      where: { id: input.accountId },
      select: { importStartDate: true, retentionFloorDate: true },
    });
    const resumed = input.resumedFromRunId
      ? await transaction.bankSyncRun.findFirst({
          where: {
            id: input.resumedFromRunId,
            accountId: input.accountId,
            status: { in: ["PARTIAL", "FAILED"] },
          },
          select: { id: true, nextCursor: true, windowStartDate: true },
        })
      : null;
    const windowStartDate = resumed?.windowStartDate ??
      fullBankSyncWindowStart(account);

    const run = await transaction.bankSyncRun.create({
      data: {
        accountId: input.accountId,
        trigger: input.trigger,
        requestedById: input.requestedById ?? null,
        resumedFromRunId: resumed?.id ?? null,
        windowStartDate,
        nextCursor: resumed?.nextCursor ?? null,
        nextAttemptAt: now,
      },
      select: { id: true },
    });
    return { runId: run.id, created: true };
  });
}

export async function requestManualBankSync(input: {
  requestedById: string;
  retryRunId?: string;
  now?: Date;
}): Promise<{ runId: string; accountId: string; created: boolean }> {
  const now = input.now ?? new Date();

  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bank-sync-manual-request'))`;
    const account = await transaction.holdedTreasuryAccount.findFirst({
      where: { active: true },
      select: {
        id: true,
        importStartDate: true,
        retentionFloorDate: true,
      },
    });
    if (!account) throw new BankSyncRequestError("not_configured");

    const existing = await transaction.bankSyncRun.findFirst({
      where: {
        accountId: account.id,
        status: { in: [...BANK_SYNC_NONTERMINAL_STATUSES] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) {
      return { runId: existing.id, accountId: account.id, created: false };
    }

    const resumed = input.retryRunId
      ? await transaction.bankSyncRun.findFirst({
          where: {
            id: input.retryRunId,
            accountId: account.id,
            status: { in: ["PARTIAL", "FAILED"] },
          },
          select: { id: true, nextCursor: true, windowStartDate: true },
        })
      : null;
    if (input.retryRunId && !resumed) {
      throw new BankSyncRequestError("invalid");
    }

    const recentManual = await transaction.bankSyncRun.findFirst({
      where: {
        accountId: account.id,
        trigger: "MANUAL",
        createdAt: {
          gt: new Date(now.getTime() - BANK_SYNC_MANUAL_COOLDOWN_MS),
        },
      },
      select: { id: true },
    });
    if (recentManual) throw new BankSyncRequestError("rate_limited");

    const run = await transaction.bankSyncRun.create({
      data: {
        accountId: account.id,
        trigger: "MANUAL",
        requestedById: input.requestedById,
        resumedFromRunId: resumed?.id ?? null,
        windowStartDate:
          resumed?.windowStartDate ??
          fullBankSyncWindowStart(account),
        nextCursor: resumed?.nextCursor ?? null,
        nextAttemptAt: now,
        createdAt: now,
      },
      select: { id: true },
    });
    return { runId: run.id, accountId: account.id, created: true };
  });
}

export async function claimBankSyncRun(
  runId: string,
  now = new Date(),
): Promise<BankSyncLease | null> {
  for (;;) {
    const candidate = await db.bankSyncRun.findFirst({
      where: {
        id: runId,
        OR: [
          {
            status: { in: ["QUEUED", "RETRYING"] },
            nextAttemptAt: { lte: now },
          },
          { status: "RUNNING", leaseExpiresAt: { lte: now } },
        ],
      },
      select: {
        id: true,
        accountId: true,
        status: true,
        pageCount: true,
        attemptCount: true,
        failureCode: true,
        windowStartDate: true,
        nextCursor: true,
        startedAt: true,
        account: { select: { holdedAccountId: true } },
      },
    });
    if (!candidate) return null;

    if (candidate.attemptCount >= BANK_SYNC_MAX_ATTEMPTS) {
      await db.bankSyncRun.updateMany({
        where: {
          id: candidate.id,
          attemptCount: { gte: BANK_SYNC_MAX_ATTEMPTS },
          OR: [
            {
              status: { in: ["QUEUED", "RETRYING"] },
              nextAttemptAt: { lte: now },
            },
            { status: "RUNNING", leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          status: candidate.pageCount > 0 ? "PARTIAL" : "FAILED",
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          finishedAt: now,
        },
      });
      return null;
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + BANK_SYNC_LEASE_MS);
    const claimed = await db.bankSyncRun.updateMany({
      where: {
        id: candidate.id,
        OR: [
          {
            status: { in: ["QUEUED", "RETRYING"] },
            nextAttemptAt: { lte: now },
          },
          { status: "RUNNING", leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: "RUNNING",
        attemptCount: { increment: 1 },
        leaseToken,
        leaseExpiresAt,
        heartbeatAt: now,
        startedAt: candidate.startedAt ?? now,
        failureCode: null,
      },
    });
    if (claimed.count !== 1) continue;

    await db.holdedTreasuryAccount.update({
      where: { id: candidate.accountId },
      data: { lastAttemptAt: now },
    });
    return {
      runId: candidate.id,
      accountId: candidate.accountId,
      holdedAccountId: candidate.account.holdedAccountId,
      windowStartDate: bankDate(candidate.windowStartDate),
      nextCursor: candidate.nextCursor,
      leaseToken,
      leaseExpiresAt,
    };
  }
}

export async function claimNextBankSync(
  now = new Date(),
): Promise<BankSyncLease | null> {
  for (;;) {
    const candidate = await db.bankSyncRun.findFirst({
      where: {
        OR: [
          {
            status: { in: ["QUEUED", "RETRYING"] },
            nextAttemptAt: { lte: now },
          },
          { status: "RUNNING", leaseExpiresAt: { lte: now } },
        ],
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (!candidate) return null;

    const lease = await claimBankSyncRun(candidate.id, now);
    if (lease) return lease;
  }
}

export async function processBankSync(
  lease: BankSyncLease,
  options: {
    provider?: BankMovementProvider;
    now?: () => Date;
  } = {},
): Promise<void> {
  const provider = options.provider ??
    createHoldedClient((await resolveIntegration("HOLDED")).secret);
  const now = options.now ?? (() => new Date());
  const seenCursors = new Set<string>();
  let cursor = lease.nextCursor ?? undefined;
  let restartedFromRejectedCursor = false;
  if (cursor) seenCursors.add(cursor);

  for (;;) {
    let page: BankMovementPage;
    try {
      page = await provider.listBankMovements({
        accountId: lease.holdedAccountId,
        startDate: lease.windowStartDate,
        cursor,
      });
      assertValidPage(page, seenCursors);
    } catch (error) {
      if (
        error instanceof HoldedError &&
        error.code === "invalid_request" &&
        cursor !== undefined &&
        !restartedFromRejectedCursor
      ) {
        const restartedAt = now();
        await restartRejectedCursor(lease, restartedAt);
        restartedFromRejectedCursor = true;
        cursor = undefined;
        seenCursors.clear();
        logger.info(
          {
            event: "bank_sync_cursor_restarted",
            runId: lease.runId,
            accountId: lease.accountId,
          },
          "bank synchronization restarted from page one",
        );
        continue;
      }

      const failure = knownFailure(error);
      if (failure) {
        await transitionAfterKnownFailure(lease, failure, now());
      }
      throw error;
    }

    const observedAt = now();
    const parsedItems = page.items.map((item, itemIndex) => ({
      itemIndex,
      result: parseHoldedBankMovement(item, lease.holdedAccountId),
    }));

    await db.$transaction(async (transaction) => {
      const run = await transaction.bankSyncRun.findUniqueOrThrow({
        where: { id: lease.runId },
        select: { pageCount: true, incidentCount: true },
      });
      let insertedCount = 0;
      let updatedCount = 0;
      let unchangedCount = 0;
      const changedMovementIds: string[] = [];
      const incidents = parsedItems.flatMap(({ itemIndex, result }) =>
        result.ok
          ? []
          : [
              {
                runId: lease.runId,
                code: result.incident.code,
                pageNumber: run.pageCount + 1,
                itemIndex,
                holdedMovementId: result.incident.holdedMovementId,
              },
            ],
      );

      for (const { result } of parsedItems) {
        if (!result.ok) continue;
        const movement = result.movement;
        const existing = await transaction.bankMovement.findUnique({
          where: {
            accountId_holdedMovementId: {
              accountId: lease.accountId,
              holdedMovementId: movement.holdedMovementId,
            },
          },
          select: {
            id: true,
            bookingDate: true,
            valueDate: true,
            narrative: true,
            amountMinor: true,
            currency: true,
            providerStatus: true,
            direction: true,
          },
        });

        if (!existing) {
          const created = await transaction.bankMovement.create({
            data: {
              accountId: lease.accountId,
              ...movement,
              firstSeenAt: observedAt,
              lastSeenAt: observedAt,
            },
            select: { id: true },
          });
          changedMovementIds.push(created.id);
          insertedCount += 1;
          continue;
        }

        const changed =
          existing.bookingDate.getTime() !== movement.bookingDate.getTime() ||
          existing.valueDate?.getTime() !== movement.valueDate?.getTime() ||
          existing.narrative !== movement.narrative ||
          existing.amountMinor !== movement.amountMinor ||
          existing.currency !== movement.currency ||
          existing.providerStatus !== movement.providerStatus ||
          existing.direction !== movement.direction;

        await transaction.bankMovement.update({
          where: {
            accountId_holdedMovementId: {
              accountId: lease.accountId,
              holdedMovementId: movement.holdedMovementId,
            },
          },
          data: {
            ...(changed ? movement : {}),
            lastSeenAt: observedAt,
          },
        });
        if (changed) {
          changedMovementIds.push(existing.id);
          updatedCount += 1;
        } else unchangedCount += 1;
      }

      if (incidents.length > 0) {
        await transaction.bankSyncIncident.createMany({ data: incidents });
      }
      const reconciliation = await reconcileBankMovements(
        changedMovementIds,
        transaction,
        {
          runId: lease.runId,
          pageNumber: run.pageCount + 1,
        },
      );

      const terminal = !page.hasMore;
      const pageIncidentCount = incidents.length + reconciliation.incidentCount;
      const totalIncidentCount = run.incidentCount + pageIncidentCount;
      const status = terminal
        ? totalIncidentCount > 0
          ? "PARTIAL"
          : "SUCCEEDED"
        : "RUNNING";
      const validMovementIds = parsedItems
        .flatMap(({ result }) => (result.ok ? [result.movement.holdedMovementId] : []))
        .toSorted();
      const checkpoint = validMovementIds.at(-1);
      const updated = await transaction.bankSyncRun.updateMany({
        where: {
          id: lease.runId,
          status: "RUNNING",
          leaseToken: lease.leaseToken,
          leaseExpiresAt: { gt: observedAt },
        },
        data: {
          status,
          pageCount: { increment: 1 },
          itemCount: { increment: page.items.length },
          insertedCount: { increment: insertedCount },
          updatedCount: { increment: updatedCount },
          unchangedCount: { increment: unchangedCount },
          incidentCount: { increment: pageIncidentCount },
          lastProcessedMovementId: checkpoint,
          nextCursor: terminal ? null : page.cursor,
          heartbeatAt: observedAt,
          leaseExpiresAt: terminal
            ? null
            : new Date(observedAt.getTime() + BANK_SYNC_LEASE_MS),
          leaseToken: terminal ? null : lease.leaseToken,
          exhaustedAt: terminal ? observedAt : null,
          finishedAt: terminal ? observedAt : null,
        },
      });
      if (updated.count !== 1) throw new Error("Bank synchronization lease was lost");

      if (terminal) {
        await transaction.holdedTreasuryAccount.update({
          where: { id: lease.accountId },
          data: {
            ...(status === "SUCCEEDED" ? { lastSuccessfulAt: observedAt } : {}),
            nextScheduledAt: new Date(observedAt.getTime() + BANK_SYNC_INTERVAL_MS),
          },
        });
      }
    });

    logger.info(
      {
        event: "bank_sync_page_committed",
        runId: lease.runId,
        accountId: lease.accountId,
        itemCount: page.items.length,
      },
      "bank movement page committed",
    );

    if (!page.hasMore) return;
    if (!page.cursor) throw new BankSyncProcessingError("MISSING_CURSOR");
    seenCursors.add(page.cursor);
    cursor = page.cursor;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export async function enqueueDueBankSyncRuns(now = new Date()): Promise<number> {
  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bank-sync-due-runs'))`;
    const account = await transaction.holdedTreasuryAccount.findFirst({
      where: { active: true, nextScheduledAt: { lte: now } },
      select: {
        id: true,
        importStartDate: true,
        retentionFloorDate: true,
      },
    });
    if (!account) return 0;

    const fullWindowStart = fullBankSyncWindowStart(account);
    const latestFullScan = await transaction.bankSyncRun.findFirst({
      where: {
        accountId: account.id,
        status: { in: ["SUCCEEDED", "PARTIAL"] },
        exhaustedAt: { not: null, lte: now },
        windowStartDate: { lte: fullWindowStart },
      },
      orderBy: [{ exhaustedAt: "desc" }, { id: "desc" }],
      select: { exhaustedAt: true },
    });

    await transaction.holdedTreasuryAccount.update({
      where: { id: account.id },
      data: { nextScheduledAt: new Date(now.getTime() + BANK_SYNC_INTERVAL_MS) },
    });
    const existing = await transaction.bankSyncRun.findFirst({
      where: {
        accountId: account.id,
        status: { in: [...BANK_SYNC_NONTERMINAL_STATUSES] },
      },
      select: { id: true },
    });
    if (existing) return 0;

    await transaction.bankSyncRun.create({
      data: {
        accountId: account.id,
        trigger: "SCHEDULED",
        windowStartDate: scheduledBankSyncWindowStart({
          ...account,
          latestFullScanAt: latestFullScan?.exhaustedAt ?? null,
          now,
        }),
        nextAttemptAt: now,
      },
    });
    return 1;
  });
}