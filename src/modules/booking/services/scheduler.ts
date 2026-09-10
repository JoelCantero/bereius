import "server-only";

import { logger } from "@/lib/logger";
import { expireUnpaidBookings } from "@/modules/booking/services/expiry";
import { runIntake } from "@/modules/booking/services/intake";
import { drainOutbox, type JobHandler } from "@/modules/booking/services/outbox";
import {
  BOOKING_MAIL_JOB_KIND,
  runBookingMailJob,
} from "@/modules/booking/services/mail";
import { QUOTE_JOB_KIND, runQuoteJob } from "@/modules/booking/services/quoting";

const HOUR_MS = 3_600_000;

export const SCHEDULES = {
  intake: HOUR_MS,
  outbox: 60_000,
  expiry: 24 * HOUR_MS,
} as const;

const JOB_HANDLERS: Readonly<Record<string, JobHandler>> = {
  [QUOTE_JOB_KIND]: runQuoteJob,
  [BOOKING_MAIL_JOB_KIND]: runBookingMailJob,
};

type TaskName = keyof typeof SCHEDULES;

const TASKS: Readonly<Record<TaskName, () => Promise<unknown>>> = {
  intake: () => runIntake(),
  outbox: () => drainOutbox(JOB_HANDLERS),
  expiry: () => expireUnpaidBookings(),
};

export interface SchedulerHandle {
  stop(): Promise<void>;
}

async function runTask(name: TaskName): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await TASKS[name]();
    logger.info(
      { event: "worker_task_completed", task: name, durationMs: Date.now() - startedAt, result },
      "worker task completed",
    );
  } catch (error) {
    // A failing task must never take the worker down: the next tick retries.
    logger.error(
      {
        event: "worker_task_failed",
        task: name,
        durationMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : "unknown",
      },
      "worker task failed",
    );
  }
}

/**
 * Starts the scheduled work inside the application process.
 *
 * Ticks never overlap: each task waits for its previous run before scheduling
 * the next, so a slow intake cannot pile up on itself. Running two instances is
 * safe by construction rather than by assumption — outbox jobs are claimed
 * atomically and intake is idempotent per entry id.
 */
export function startScheduler(): SchedulerHandle {
  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();

  function schedule(name: TaskName, delay: number) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopping) return;

      const run = runTask(name).finally(() => {
        inFlight.delete(run);
        if (!stopping) schedule(name, SCHEDULES[name]);
      });
      inFlight.add(run);
    }, delay);

    timers.add(timer);
  }

  for (const name of Object.keys(SCHEDULES) as TaskName[]) {
    schedule(name, 0);
  }

  logger.info({ event: "booking_scheduler_started", schedules: SCHEDULES }, "booking scheduler started");

  return {
    async stop() {
      stopping = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // Lets a claimed job finish rather than abandoning it mid-flight.
      await Promise.allSettled([...inFlight]);
      logger.info({ event: "booking_scheduler_stopped" }, "booking scheduler stopped");
    },
  };
}

/** Registers shutdown handling once, so a claimed job is not abandoned. */
export function registerScheduler(): SchedulerHandle {
  const scheduler = startScheduler();
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { event: "booking_scheduler_shutdown", signal },
      "booking scheduler shutting down",
    );
    void scheduler.stop();
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  return scheduler;
}
