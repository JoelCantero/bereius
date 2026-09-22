const DAY_MS = 24 * 60 * 60 * 1_000;

export const BANK_SYNC_RECENT_WINDOW_DAYS = 14;
export const BANK_SYNC_FULL_WINDOW_INTERVAL_MS = DAY_MS;

export function fullBankSyncWindowStart(input: {
  importStartDate: Date;
  retentionFloorDate: Date | null;
}) {
  return input.retentionFloorDate &&
    input.retentionFloorDate > input.importStartDate
    ? input.retentionFloorDate
    : input.importStartDate;
}

export function scheduledBankSyncWindowStart(input: {
  importStartDate: Date;
  retentionFloorDate: Date | null;
  latestFullScanAt: Date | null;
  now: Date;
}) {
  const fullWindowStart = fullBankSyncWindowStart(input);
  const fullScanCutoff = new Date(
    input.now.getTime() - BANK_SYNC_FULL_WINDOW_INTERVAL_MS,
  );
  const hasRecentFullScan = Boolean(
    input.latestFullScanAt &&
      input.latestFullScanAt > fullScanCutoff &&
      input.latestFullScanAt <= input.now,
  );
  if (!hasRecentFullScan) return fullWindowStart;

  const overlapStart = new Date(
    Date.UTC(
      input.now.getUTCFullYear(),
      input.now.getUTCMonth(),
      input.now.getUTCDate(),
    ),
  );
  overlapStart.setUTCDate(
    overlapStart.getUTCDate() - BANK_SYNC_RECENT_WINDOW_DAYS,
  );
  return overlapStart > fullWindowStart ? overlapStart : fullWindowStart;
}