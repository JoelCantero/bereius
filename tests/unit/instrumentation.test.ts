// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.hoisted(() => vi.fn());
const schedulerMocks = vi.hoisted(() => ({
  claimNextBankSync: vi.fn(),
  drainOutbox: vi.fn(),
  enqueueDueBankSyncRuns: vi.fn(),
  expireUnpaidBookings: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  processBankSync: vi.fn(),
  runBankRetention: vi.fn(),
  runBookingMailJob: vi.fn(),
  runIntake: vi.fn(),
  runQuoteJob: vi.fn(),
  runReserveInvoiceJob: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getEnv: getEnvMock }));
vi.mock("@/lib/logger", () => ({
  logger: { error: schedulerMocks.loggerError, info: schedulerMocks.loggerInfo },
}));
vi.mock("@/modules/banking/services/synchronization", () => ({
  claimNextBankSync: schedulerMocks.claimNextBankSync,
  enqueueDueBankSyncRuns: schedulerMocks.enqueueDueBankSyncRuns,
  processBankSync: schedulerMocks.processBankSync,
}));
vi.mock("@/modules/banking/services/retention", () => ({
  runBankRetention: schedulerMocks.runBankRetention,
}));
vi.mock("@/modules/booking/services/expiry", () => ({
  expireUnpaidBookings: schedulerMocks.expireUnpaidBookings,
}));
vi.mock("@/modules/booking/services/intake", () => ({
  runIntake: schedulerMocks.runIntake,
}));
vi.mock("@/modules/booking/services/outbox", () => ({
  drainOutbox: schedulerMocks.drainOutbox,
}));
vi.mock("@/modules/booking/services/mail", () => ({
  BOOKING_MAIL_JOB_KIND: "booking-mail",
  runBookingMailJob: schedulerMocks.runBookingMailJob,
}));
vi.mock("@/modules/booking/services/quoting", () => ({
  QUOTE_JOB_KIND: "quote",
  runQuoteJob: schedulerMocks.runQuoteJob,
}));
vi.mock("@/modules/booking/services/reserve-invoice", () => ({
  RESERVE_INVOICE_JOB_KIND: "reserve-invoice",
  runReserveInvoiceJob: schedulerMocks.runReserveInvoiceJob,
}));

import { register } from "@/instrumentation";
import {
  registerScheduler,
  SCHEDULES,
  startScheduler,
} from "@/modules/booking/services/scheduler";

const originalRuntime = process.env.NEXT_RUNTIME;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Next.js startup registration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getEnvMock.mockReset();
    vi.clearAllMocks();
    schedulerMocks.enqueueDueBankSyncRuns.mockResolvedValue(0);
    schedulerMocks.claimNextBankSync.mockResolvedValue(null);
    schedulerMocks.processBankSync.mockResolvedValue(undefined);
    schedulerMocks.runIntake.mockResolvedValue({ created: 0 });
    schedulerMocks.drainOutbox.mockResolvedValue({ processed: 0 });
    schedulerMocks.expireUnpaidBookings.mockResolvedValue({
      examined: 0,
      expired: 0,
    });
    schedulerMocks.runBankRetention.mockResolvedValue({
      accountsAdvanced: 0,
      movementsDeleted: 0,
      proposalsDeleted: 0,
      runsDeleted: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
    vi.restoreAllMocks();
  });

  it("validates the environment synchronously before readiness", () => {
    getEnvMock.mockReturnValue({ MAIL: { enabled: false } });

    expect(register()).toBeUndefined();
    expect(getEnvMock).toHaveBeenCalledOnce();
    expect(getEnvMock).toHaveBeenCalledWith();
  });

  it("propagates malformed global-brand failure without exposing a value", () => {
    const suppliedValue = "private-invalid-brand-value";
    getEnvMock.mockImplementation(() => {
      throw new Error(
        "Invalid environment configuration:\nBRAND_COLOR: must be #RRGGBB",
      );
    });

    expect(() => register()).toThrow(/BRAND_COLOR/);
    try {
      register();
    } catch (error) {
      expect(String(error)).not.toContain(suppliedValue);
    }
    expect(getEnvMock).toHaveBeenCalledTimes(2);
  });
});

describe("booking worker scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    schedulerMocks.enqueueDueBankSyncRuns.mockResolvedValue(0);
    schedulerMocks.claimNextBankSync.mockResolvedValue(null);
    schedulerMocks.processBankSync.mockResolvedValue(undefined);
    schedulerMocks.runIntake.mockResolvedValue({ created: 0 });
    schedulerMocks.drainOutbox.mockResolvedValue({ processed: 0 });
    schedulerMocks.expireUnpaidBookings.mockResolvedValue({
      examined: 0,
      expired: 0,
    });
    schedulerMocks.runBankRetention.mockResolvedValue({
      accountsAdvanced: 0,
      movementsDeleted: 0,
      proposalsDeleted: 0,
      runsDeleted: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers banking sweeps plus daily expiry and retention", () => {
    expect(SCHEDULES).toEqual({
      banking: 60_000,
      intake: 3_600_000,
      outbox: 60_000,
      expiry: 86_400_000,
      retention: 86_400_000,
    });
  });

  it("registers graceful shutdown handlers for both process signals", async () => {
    const once = vi.spyOn(process, "once").mockImplementation(() => process);

    const scheduler = registerScheduler();

    expect(once).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(once).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    await scheduler.stop();
  });

  it("enqueues due banking work and processes its claimed run", async () => {
    const lease = {
      runId: "local-due-run",
      accountId: "local-account",
      holdedAccountId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      windowStartDate: "2026-06-18",
      nextCursor: null,
      leaseToken: "local-lease",
      leaseExpiresAt: new Date("2026-09-16T12:02:00.000Z"),
    };
    schedulerMocks.enqueueDueBankSyncRuns.mockResolvedValue(1);
    schedulerMocks.claimNextBankSync.mockResolvedValueOnce(lease).mockResolvedValue(null);
    const scheduler = startScheduler();

    await vi.advanceTimersByTimeAsync(0);

    expect(schedulerMocks.enqueueDueBankSyncRuns).toHaveBeenCalledOnce();
    expect(schedulerMocks.processBankSync).toHaveBeenCalledWith(lease);
    expect(schedulerMocks.runBankRetention).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it("isolates one task failure from every other initial task", async () => {
    schedulerMocks.runIntake.mockRejectedValueOnce(new Error("synthetic intake failure"));
    const scheduler = startScheduler();

    await vi.advanceTimersByTimeAsync(0);

    expect(schedulerMocks.enqueueDueBankSyncRuns).toHaveBeenCalledOnce();
    expect(schedulerMocks.drainOutbox).toHaveBeenCalledOnce();
    expect(schedulerMocks.expireUnpaidBookings).toHaveBeenCalledOnce();
    expect(schedulerMocks.runBankRetention).toHaveBeenCalledOnce();
    expect(schedulerMocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: "worker_task_failed", task: "intake" }),
      "worker task failed",
    );
    await scheduler.stop();
  });

  it("never overlaps a slow banking sweep with its next interval", async () => {
    const pending = deferred();
    schedulerMocks.enqueueDueBankSyncRuns.mockImplementation(() => pending.promise);
    const scheduler = startScheduler();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SCHEDULES.banking * 3);
    expect(schedulerMocks.enqueueDueBankSyncRuns).toHaveBeenCalledOnce();

    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SCHEDULES.banking);
    expect(schedulerMocks.enqueueDueBankSyncRuns).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("waits for claimed in-flight work during a graceful stop", async () => {
    const pending = deferred();
    schedulerMocks.enqueueDueBankSyncRuns.mockImplementation(() => pending.promise);
    const scheduler = startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;

    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    pending.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });
});
