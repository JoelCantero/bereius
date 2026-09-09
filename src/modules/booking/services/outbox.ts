import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { IntegrationJobStatus } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export const MAX_ATTEMPTS = 6;
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 3_600_000;

export interface OutboxJob {
  id: string;
  kind: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
}

export interface EnqueueCommand {
  kind: string;
  /** Derived from the booking and the step, so a retry never enqueues twice. */
  idempotencyKey: string;
  payload: object;
  runAfter?: Date;
}

/** Exponential with a ceiling, so a long outage does not push work past a day. */
export function backoffFor(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
}

/**
 * Returns false when the job already exists, which is the normal outcome of a
 * retried enqueue rather than an error.
 */
export async function enqueueJob(
  command: EnqueueCommand,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<boolean> {
  try {
    await client.integrationJob.create({
      data: {
        kind: command.kind,
        idempotencyKey: command.idempotencyKey,
        payload: command.payload,
        runAfter: command.runAfter ?? new Date(),
      },
    });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Claims one due job atomically.
 *
 * The update is conditioned on the row still being PENDING, so two workers, or
 * two overlapping runs of the same worker, cannot take the same job.
 */
export async function claimNextJob(now: Date = new Date()): Promise<OutboxJob | null> {
  for (;;) {
    const candidate = await db.integrationJob.findFirst({
      where: { status: "PENDING", runAfter: { lte: now } },
      orderBy: { runAfter: "asc" },
      select: {
        id: true,
        kind: true,
        idempotencyKey: true,
        payload: true,
        attempts: true,
      },
    });

    if (!candidate) return null;

    const claimed = await db.integrationJob.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "CLAIMED", claimedAt: now, attempts: { increment: 1 } },
    });

    if (claimed.count === 1) {
      return { ...candidate, attempts: candidate.attempts + 1 };
    }
    // Another run took it between the read and the update; try the next one.
  }
}

export async function completeJob(jobId: string): Promise<void> {
  await db.integrationJob.update({
    where: { id: jobId },
    data: { status: "SUCCEEDED", lastError: null },
  });
}

/**
 * Schedules a retry, or parks the job once it has exhausted its attempts.
 * A dead job stays in the table and is visible; it is never dropped.
 */
export async function failJob(
  job: OutboxJob,
  error: unknown,
  now: Date = new Date(),
): Promise<IntegrationJobStatus> {
  const exhausted = job.attempts >= MAX_ATTEMPTS;
  const message = error instanceof Error ? error.message : String(error);

  await db.integrationJob.update({
    where: { id: job.id },
    data: {
      status: exhausted ? "DEAD" : "PENDING",
      // Truncated: a provider can return a very long body.
      lastError: message.slice(0, 500),
      runAfter: exhausted ? undefined : new Date(now.getTime() + backoffFor(job.attempts)),
    },
  });

  return exhausted ? "DEAD" : "PENDING";
}

export type JobHandler = (job: OutboxJob) => Promise<void>;

export interface DrainSummary {
  processed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

/**
 * Runs due jobs until none remain or the batch limit is reached. A handler that
 * throws is retried; an unknown kind is parked immediately, because retrying it
 * cannot help.
 */
export async function drainOutbox(
  handlers: Readonly<Record<string, JobHandler>>,
  options: { limit?: number; now?: Date } = {},
): Promise<DrainSummary> {
  const limit = options.limit ?? 25;
  const summary: DrainSummary = { processed: 0, succeeded: 0, retried: 0, dead: 0 };

  while (summary.processed < limit) {
    const job = await claimNextJob(options.now);
    if (!job) break;

    summary.processed += 1;
    const handler = handlers[job.kind];

    if (!handler) {
      await db.integrationJob.update({
        where: { id: job.id },
        data: { status: "DEAD", lastError: `No handler for job kind ${job.kind}` },
      });
      summary.dead += 1;
      logger.error(
        { event: "booking_outbox_unknown_kind", jobId: job.id, kind: job.kind },
        "outbox job has no handler",
      );
      continue;
    }

    try {
      await handler(job);
      await completeJob(job.id);
      summary.succeeded += 1;
    } catch (error) {
      const outcome = await failJob(job, error, options.now);
      if (outcome === "DEAD") {
        summary.dead += 1;
      } else {
        summary.retried += 1;
      }
      logger.warn(
        {
          event: "booking_outbox_job_failed",
          jobId: job.id,
          kind: job.kind,
          attempts: job.attempts,
          outcome,
        },
        "outbox job failed",
      );
    }
  }

  return summary;
}
