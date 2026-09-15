// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireBookingActor: vi.fn(),
  runIntake: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn } }));
vi.mock("@/modules/booking/authorization", () => {
  class AuthorizationError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }

  return {
    AuthorizationError,
    requireBookingActor: mocks.requireBookingActor,
  };
});
vi.mock("@/modules/booking/services/intake", () => ({ runIntake: mocks.runIntake }));
vi.mock("@/modules/booking/services/settings", () => {
  class IntegrationSettingsError extends Error {}

  return { IntegrationSettingsError };
});

import { GravityFormsError } from "@/lib/gravity-forms/client";
import { AuthorizationError } from "@/modules/booking/authorization";
import { refreshIntakeAction } from "@/modules/booking/actions/intake";

describe("manual booking intake action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBookingActor.mockResolvedValue({ userId: "operator-1", role: "OPERATOR" });
  });

  it("imports new entries and revalidates the queue", async () => {
    mocks.runIntake.mockResolvedValue({
      read: 3,
      created: 1,
      skipped: 1,
      rejected: 1,
      cursor: "420",
    });

    await expect(refreshIntakeAction()).resolves.toEqual({
      status: "done",
      created: 1,
      skipped: 1,
      rejected: 1,
    });
    expect(mocks.requireBookingActor).toHaveBeenCalledOnce();
    expect(mocks.runIntake).toHaveBeenCalledOnce();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/bookings");
  });

  it("does not run intake for an unauthenticated request", async () => {
    mocks.requireBookingActor.mockRejectedValue(new AuthorizationError("unauthenticated"));

    await expect(refreshIntakeAction()).resolves.toEqual({
      status: "error",
      reason: "unauthenticated",
    });
    expect(mocks.runIntake).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a Gravity Forms outage without revalidating", async () => {
    mocks.runIntake.mockRejectedValue(
      new GravityFormsError("unavailable", "Gravity Forms is unreachable"),
    );

    await expect(refreshIntakeAction()).resolves.toEqual({
      status: "error",
      reason: "connection",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      { event: "booking_intake_manual_failed", reason: "connection" },
      "manual booking intake failed",
    );
  });
});