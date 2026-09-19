import "server-only";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { BANK_SYNC_NONTERMINAL_STATUSES } from "@/modules/banking/schema";
import {
  claimBankSyncRun,
  enqueueBankSync,
  processBankSync,
} from "@/modules/banking/services/synchronization";

export type BankExpiryEvidence =
  | { ready: true; runId: string }
  | {
      ready: false;
      reason:
        | "not_configured"
        | "running"
        | "retrying"
        | "partial"
        | "failed"
        | "unavailable";
    };

interface ExpiryEvidenceOptions {
  clock?: () => Date;
}

async function inspectRun(
  runId: string,
  expiryAttemptStartedAt: Date,
): Promise<BankExpiryEvidence | null> {
  const run = await db.bankSyncRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      startedAt: true,
      exhaustedAt: true,
    },
  });
  if (!run) return { ready: false, reason: "unavailable" };

  const fresh = Boolean(
    run.startedAt && run.startedAt >= expiryAttemptStartedAt,
  );
  if (run.status === "SUCCEEDED") {
    return fresh && run.exhaustedAt
      ? { ready: true, runId: run.id }
      : null;
  }
  if (run.status === "RETRYING") {
    return { ready: false, reason: "retrying" };
  }
  if (run.status === "PARTIAL" && fresh) {
    return { ready: false, reason: "partial" };
  }
  if (run.status === "FAILED" && fresh) {
    return { ready: false, reason: "failed" };
  }
  if (run.status === "QUEUED" || run.status === "RUNNING") {
    return { ready: false, reason: "running" };
  }
  return null;
}

export async function ensureFreshBankEvidenceForExpiry(
  expiryAttemptStartedAt: Date,
  options: ExpiryEvidenceOptions = {},
): Promise<BankExpiryEvidence> {
  const clock = options.clock ?? (() => new Date());
  const account = await db.holdedTreasuryAccount.findFirst({
    where: { active: true },
    select: { id: true },
  });
  if (!account) return { ready: false, reason: "not_configured" };

  for (let step = 0; step < 4; step += 1) {
    const latestRun = await db.bankSyncRun.findFirst({
      where: { accountId: account.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (latestRun) {
      const inspected = await inspectRun(
        latestRun.id,
        expiryAttemptStartedAt,
      );
      if (inspected?.ready || inspected?.reason !== "running") {
        if (inspected) return inspected;
      }
    }

    const activeRun = await db.bankSyncRun.findFirst({
      where: {
        accountId: account.id,
        status: { in: [...BANK_SYNC_NONTERMINAL_STATUSES] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, status: true },
    });
    if (activeRun?.status === "RETRYING") {
      return { ready: false, reason: "retrying" };
    }

    const targetRunId = activeRun
      ? activeRun.id
      : (
          await enqueueBankSync({
            accountId: account.id,
            trigger: "EXPIRY",
            now: clock(),
          })
        ).runId;
    const lease = await claimBankSyncRun(targetRunId, clock());
    if (!lease) return { ready: false, reason: "running" };

    try {
      await processBankSync(lease, { now: clock });
    } catch {
      logger.warn(
        {
          event: "bank_expiry_sync_deferred",
          runId: lease.runId,
          accountId: lease.accountId,
        },
        "bank synchronization did not provide expiry evidence",
      );
    }

    const inspected = await inspectRun(
      lease.runId,
      expiryAttemptStartedAt,
    );
    if (inspected) return inspected;
  }

  return { ready: false, reason: "unavailable" };
}