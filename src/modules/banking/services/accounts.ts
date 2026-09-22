import "server-only";

import { db } from "@/lib/db";
import { createHoldedClient, HoldedError } from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import { BANK_RETENTION_DAYS, VERIFIED_BANK_CURRENCY } from "@/modules/banking/schema";
import {
  IntegrationSettingsError,
  resolveIntegration,
} from "@/modules/booking/services/settings";

export interface TreasuryAccountOption {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
}

export type TreasuryAccountOptionsResult =
  | { status: "ok"; options: TreasuryAccountOption[] }
  | {
      status: "not_configured" | "unauthorized" | "unavailable";
      options: [];
    };

export interface TreasuryAccountSettings {
  id: string;
  holdedAccountId: string;
  displayName: string;
  currency: string;
  importStartDate: string;
  importStartDateLocked: boolean;
}

export class TreasuryAccountError extends Error {
  constructor(
    readonly code: "account_unavailable" | "start_date_locked",
  ) {
    super(code);
    this.name = "TreasuryAccountError";
  }
}

function bankDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function dateFromBankDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function defaultBankImportStartDate(now = new Date()): string {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  date.setUTCDate(date.getUTCDate() - BANK_RETENTION_DAYS);
  return bankDate(date);
}

async function fetchTreasuryAccounts(options: { fresh?: boolean } = {}) {
  const { secret } = await resolveIntegration("HOLDED");
  return createHoldedClient(secret).listTreasuryAccounts(options);
}

function eligibleAccounts(accounts: Awaited<ReturnType<typeof fetchTreasuryAccounts>>) {
  return accounts.filter(
    (account) => !account.archived && account.currency === VERIFIED_BANK_CURRENCY,
  );
}

export async function listTreasuryAccountOptions(): Promise<TreasuryAccountOptionsResult> {
  try {
    return { status: "ok", options: eligibleAccounts(await fetchTreasuryAccounts()) };
  } catch (error) {
    if (error instanceof IntegrationSettingsError && error.code === "not_configured") {
      return { status: "not_configured", options: [] };
    }

    const status =
      error instanceof HoldedError &&
      (error.code === "unauthorized" || error.code === "not_found")
        ? "unauthorized"
        : "unavailable";
    logger.warn(
      {
        event: "bank_treasury_accounts_failed",
        code: error instanceof HoldedError ? error.code : "unexpected",
      },
      "treasury account discovery failed",
    );
    return { status, options: [] };
  }
}

export async function getTreasuryAccountSettings(): Promise<TreasuryAccountSettings | null> {
  const account = await db.holdedTreasuryAccount.findFirst({
    where: { active: true },
    select: {
      id: true,
      holdedAccountId: true,
      displayName: true,
      currency: true,
      importStartDate: true,
      syncRuns: { select: { id: true }, take: 1 },
    },
  });
  if (!account) return null;

  return {
    id: account.id,
    holdedAccountId: account.holdedAccountId,
    displayName: account.displayName,
    currency: account.currency,
    importStartDate: bankDate(account.importStartDate),
    importStartDateLocked: account.syncRuns.length > 0,
  };
}

export async function saveTreasuryAccount(command: {
  holdedAccountId: string;
  importStartDate: string;
  configuredById: string;
  now?: Date;
}): Promise<{ accountId: string; runId: string | null }> {
  const selected = eligibleAccounts(
    await fetchTreasuryAccounts({ fresh: true }),
  ).find(
    (account) => account.id === command.holdedAccountId,
  );
  if (!selected) throw new TreasuryAccountError("account_unavailable");

  const requestedStartDate = dateFromBankDate(command.importStartDate);
  const now = command.now ?? new Date();

  return db.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bank-treasury-account-configuration'))`;

    const existing = await transaction.holdedTreasuryAccount.findUnique({
      where: { holdedAccountId: selected.id },
      select: { id: true, importStartDate: true },
    });
    const previousRun = existing
      ? await transaction.bankSyncRun.findFirst({
          where: { accountId: existing.id },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        })
      : null;

    if (
      existing &&
      previousRun &&
      bankDate(existing.importStartDate) !== command.importStartDate
    ) {
      throw new TreasuryAccountError("start_date_locked");
    }

    await transaction.holdedTreasuryAccount.updateMany({
      where: { active: true },
      data: { active: false },
    });

    const account = existing
      ? await transaction.holdedTreasuryAccount.update({
          where: { id: existing.id },
          data: {
            displayName: selected.name,
            currency: selected.currency,
            importStartDate: previousRun ? undefined : requestedStartDate,
            configuredById: command.configuredById,
            active: true,
            nextScheduledAt: now,
          },
          select: { id: true, importStartDate: true },
        })
      : await transaction.holdedTreasuryAccount.create({
          data: {
            holdedAccountId: selected.id,
            displayName: selected.name,
            currency: selected.currency,
            importStartDate: requestedStartDate,
            configuredById: command.configuredById,
            active: true,
            nextScheduledAt: now,
          },
          select: { id: true, importStartDate: true },
        });

    if (previousRun) return { accountId: account.id, runId: null };

    const run = await transaction.bankSyncRun.create({
      data: {
        accountId: account.id,
        trigger: "SCHEDULED",
        windowStartDate: account.importStartDate,
        nextAttemptAt: now,
      },
      select: { id: true },
    });
    return { accountId: account.id, runId: run.id };
  });
}