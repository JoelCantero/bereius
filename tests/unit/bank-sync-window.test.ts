import { describe, expect, it } from "vitest";

import { scheduledBankSyncWindowStart } from "@/modules/banking/synchronization-window";

describe("scheduledBankSyncWindowStart", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  const importStartDate = new Date("2026-01-01T00:00:00.000Z");
  const retentionFloorDate = new Date("2026-06-18T00:00:00.000Z");

  it("uses a 14-day overlap after a full scan completed less than one day ago", () => {
    expect(
      scheduledBankSyncWindowStart({
        importStartDate,
        retentionFloorDate,
        latestFullScanAt: new Date("2026-09-16T00:00:00.000Z"),
        now,
      }),
    ).toEqual(new Date("2026-09-02T00:00:00.000Z"));
  });

  it("requires the full retained window when full evidence is one day old", () => {
    expect(
      scheduledBankSyncWindowStart({
        importStartDate,
        retentionFloorDate,
        latestFullScanAt: new Date("2026-09-15T12:00:00.000Z"),
        now,
      }),
    ).toEqual(retentionFloorDate);
  });

  it("requires the full retained window when full evidence is in the future", () => {
    expect(
      scheduledBankSyncWindowStart({
        importStartDate,
        retentionFloorDate,
        latestFullScanAt: new Date("2026-09-16T12:00:00.001Z"),
        now,
      }),
    ).toEqual(retentionFloorDate);
  });

  it("never starts before a newer configured or retained boundary", () => {
    const newerImportStart = new Date("2026-09-10T00:00:00.000Z");

    expect(
      scheduledBankSyncWindowStart({
        importStartDate: newerImportStart,
        retentionFloorDate: null,
        latestFullScanAt: new Date("2026-09-16T00:00:00.000Z"),
        now,
      }),
    ).toEqual(newerImportStart);
  });
});