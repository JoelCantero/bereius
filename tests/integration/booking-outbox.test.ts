// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import { db } from "@/lib/db";
import {
  BASE_BACKOFF_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  backoffFor,
  claimNextJob,
  drainOutbox,
  enqueueJob,
  type OutboxJob,
} from "@/modules/booking/services/outbox";

describe("outbox backoff", () => {
  it("grows exponentially and then stops growing", () => {
    expect(backoffFor(1)).toBe(BASE_BACKOFF_MS);
    expect(backoffFor(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffFor(3)).toBe(BASE_BACKOFF_MS * 4);
    expect(backoffFor(50)).toBe(MAX_BACKOFF_MS);
  });
});

describe.skipIf(!runIntegrationTests)("booking outbox integration", () => {
  const keys: string[] = [];

  function key(name: string) {
    const value = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    keys.push(value);
    return value;
  }

  afterEach(async () => {
    await db.integrationJob.deleteMany({ where: { idempotencyKey: { in: keys } } });
    keys.length = 0;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("enqueues once per idempotency key", async () => {
    const idempotencyKey = key("quote");

    await expect(
      enqueueJob({ kind: "test.noop", idempotencyKey, payload: { a: 1 } }),
    ).resolves.toBe(true);
    await expect(
      enqueueJob({ kind: "test.noop", idempotencyKey, payload: { a: 2 } }),
    ).resolves.toBe(false);

    await expect(
      db.integrationJob.count({ where: { idempotencyKey } }),
    ).resolves.toBe(1);
  });

  it("never hands the same job to two concurrent claims", async () => {
    const idempotencyKey = key("claim-race");
    await enqueueJob({ kind: "test.noop", idempotencyKey, payload: {} });

    const claims = await Promise.all([
      claimNextJob(),
      claimNextJob(),
      claimNextJob(),
    ]);
    const claimed = claims.filter(
      (job): job is OutboxJob => job?.idempotencyKey === idempotencyKey,
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.attempts).toBe(1);
  });

  it("does not claim a job scheduled for the future", async () => {
    const idempotencyKey = key("future");
    await enqueueJob({
      kind: "test.noop",
      idempotencyKey,
      payload: {},
      runAfter: new Date(Date.now() + 600_000),
    });

    const claimed = await claimNextJob();

    expect(claimed?.idempotencyKey).not.toBe(idempotencyKey);
  });

  it("runs a successful job exactly once", async () => {
    const idempotencyKey = key("success");
    await enqueueJob({ kind: "test.count", idempotencyKey, payload: {} });
    const handler = vi.fn(async () => {});

    await drainOutbox({ "test.count": handler }, { limit: 5 });
    await drainOutbox({ "test.count": handler }, { limit: 5 });

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(
      db.integrationJob.findFirstOrThrow({ where: { idempotencyKey } }),
    ).resolves.toMatchObject({ status: "SUCCEEDED", attempts: 1 });
  });

  it("reschedules a failing job with backoff instead of losing it", async () => {
    const idempotencyKey = key("retry");
    await enqueueJob({ kind: "test.fail", idempotencyKey, payload: {} });
    const now = new Date();

    const summary = await drainOutbox(
      {
        "test.fail": async () => {
          throw new Error("provider unavailable");
        },
      },
      { limit: 5, now },
    );

    expect(summary).toMatchObject({ processed: 1, retried: 1, dead: 0 });

    const job = await db.integrationJob.findFirstOrThrow({ where: { idempotencyKey } });
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(1);
    expect(job.lastError).toContain("provider unavailable");
    expect(job.runAfter.getTime()).toBe(now.getTime() + BASE_BACKOFF_MS);
  });

  it("parks a job once its attempts are exhausted, and keeps it visible", async () => {
    const idempotencyKey = key("dead");
    await enqueueJob({ kind: "test.fail", idempotencyKey, payload: {} });
    await db.integrationJob.updateMany({
      where: { idempotencyKey },
      data: { attempts: MAX_ATTEMPTS - 1 },
    });

    const summary = await drainOutbox(
      {
        "test.fail": async () => {
          throw new Error("still failing");
        },
      },
      { limit: 5 },
    );

    expect(summary).toMatchObject({ dead: 1, retried: 0 });
    await expect(
      db.integrationJob.findFirstOrThrow({ where: { idempotencyKey } }),
    ).resolves.toMatchObject({ status: "DEAD", attempts: MAX_ATTEMPTS });
  });

  it("parks a job whose kind has no handler rather than retrying forever", async () => {
    const idempotencyKey = key("orphan");
    await enqueueJob({ kind: "test.unregistered", idempotencyKey, payload: {} });

    const summary = await drainOutbox({}, { limit: 5 });

    expect(summary.dead).toBeGreaterThanOrEqual(1);
    await expect(
      db.integrationJob.findFirstOrThrow({ where: { idempotencyKey } }),
    ).resolves.toMatchObject({ status: "DEAD" });
  });

  it("truncates a very long provider error", async () => {
    const idempotencyKey = key("long-error");
    await enqueueJob({ kind: "test.fail", idempotencyKey, payload: {} });

    await drainOutbox(
      {
        "test.fail": async () => {
          throw new Error("x".repeat(5_000));
        },
      },
      { limit: 5 },
    );

    const job = await db.integrationJob.findFirstOrThrow({ where: { idempotencyKey } });
    expect(job.lastError).toHaveLength(500);
  });
});
