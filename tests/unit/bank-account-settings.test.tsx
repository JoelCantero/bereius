import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const listTreasuryAccounts = vi.fn();
  const transaction = {
    $executeRaw: vi.fn(),
    holdedTreasuryAccount: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    bankSyncRun: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };

  return {
    createHoldedClient: vi.fn(() => ({ listTreasuryAccounts })),
    listTreasuryAccounts,
    resolveIntegration: vi.fn(),
    findActiveAccount: vi.fn(),
    transaction,
    runTransaction: vi.fn(),
    requireBankingActor: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/db", () => ({
  db: {
    holdedTreasuryAccount: { findFirst: mocks.findActiveAccount },
    $transaction: mocks.runTransaction,
  },
}));
vi.mock("@/lib/holded/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/holded/client")>();
  return { ...original, createHoldedClient: mocks.createHoldedClient };
});
vi.mock("@/modules/booking/services/settings", () => {
  class IntegrationSettingsError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }

  return {
    IntegrationSettingsError,
    resolveIntegration: mocks.resolveIntegration,
  };
});
vi.mock("@/modules/banking/authorization", () => {
  class BankingAuthorizationError extends Error {
    constructor(readonly code: "unauthenticated" | "forbidden") {
      super(code);
    }
  }

  return {
    BankingAuthorizationError,
    requireBankingActor: mocks.requireBankingActor,
  };
});
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { HoldedError } from "@/lib/holded/client";
import { BankingAuthorizationError } from "@/modules/banking/authorization";
import { saveTreasuryAccountAction } from "@/modules/banking/actions/settings";
import { TreasuryAccountSettings } from "@/modules/banking/components/treasury-account-settings";
import {
  defaultBankImportStartDate,
  listTreasuryAccountOptions,
  saveTreasuryAccount,
} from "@/modules/banking/services/accounts";
import { createHoldedTreasuryFixtureScope } from "../helpers/holded-treasury";

describe("treasury account settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveIntegration.mockResolvedValue({ config: {}, secret: "stored-secret" });
    mocks.requireBankingActor.mockResolvedValue({
      userId: "administrator-1",
      role: "ADMINISTRATOR",
    });
    mocks.runTransaction.mockImplementation(
      async (operation: (transaction: typeof mocks.transaction) => Promise<unknown>) =>
        operation(mocks.transaction),
    );
    mocks.transaction.$executeRaw.mockResolvedValue(1);
    mocks.transaction.holdedTreasuryAccount.findUnique.mockResolvedValue(null);
    mocks.transaction.holdedTreasuryAccount.updateMany.mockResolvedValue({ count: 0 });
    mocks.transaction.holdedTreasuryAccount.create.mockResolvedValue({
      id: "local-account-1",
      importStartDate: new Date("2026-06-18T00:00:00.000Z"),
    });
    mocks.transaction.bankSyncRun.findFirst.mockResolvedValue(null);
    mocks.transaction.bankSyncRun.create.mockResolvedValue({ id: "run-1" });
  });

  it("calculates the first import as 90 UTC calendar days before configuration", () => {
    expect(defaultBankImportStartDate(new Date("2026-09-16T23:59:59.000Z"))).toBe(
      "2026-06-18",
    );
    expect(defaultBankImportStartDate(new Date("2028-03-30T00:00:00.000Z"))).toBe(
      "2027-12-31",
    );
  });

  it("fetches fresh options with the stored credential and returns only eligible EUR accounts", async () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const eligible = fixtures.account({ name: "Eligible account" });
    const archived = fixtures.account({ name: "Archived account", archived: true });
    const nonEur = fixtures.account({ name: "Dollar account", currency: "USD" });
    mocks.listTreasuryAccounts
      .mockResolvedValueOnce([archived, eligible, nonEur])
      .mockResolvedValueOnce([]);

    await expect(listTreasuryAccountOptions()).resolves.toEqual({
      status: "ok",
      options: [eligible],
    });
    await expect(listTreasuryAccountOptions()).resolves.toEqual({
      status: "ok",
      options: [],
    });

    expect(mocks.resolveIntegration).toHaveBeenCalledTimes(2);
    expect(mocks.resolveIntegration).toHaveBeenCalledWith("HOLDED");
    expect(mocks.createHoldedClient).toHaveBeenCalledTimes(2);
    expect(mocks.createHoldedClient).toHaveBeenCalledWith("stored-secret");
    expect(mocks.listTreasuryAccounts).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new HoldedError("unauthorized", "opaque"), "unauthorized"],
    [new HoldedError("unavailable", "opaque"), "unavailable"],
  ] as const)("returns a sanitized provider option state", async (error, status) => {
    mocks.listTreasuryAccounts.mockRejectedValue(error);

    await expect(listTreasuryAccountOptions()).resolves.toEqual({
      status,
      options: [],
    });
  });

  it.each([
    { archived: true, currency: "EUR" },
    { archived: false, currency: "USD" },
  ])("rejects an account that became ineligible before save", async (eligibility) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account(eligibility);
    mocks.listTreasuryAccounts.mockResolvedValue([account]);

    await expect(
      saveTreasuryAccount({
        holdedAccountId: account.id,
        importStartDate: "2026-06-18",
        configuredById: "administrator-1",
      }),
    ).rejects.toMatchObject({ code: "account_unavailable" });
    expect(mocks.listTreasuryAccounts).toHaveBeenCalledWith({ fresh: true });
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("refuses to change a historical account's locked import date", async () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    mocks.listTreasuryAccounts.mockResolvedValue([account]);
    mocks.transaction.holdedTreasuryAccount.findUnique.mockResolvedValue({
      id: "local-account-1",
      importStartDate: new Date("2026-05-01T00:00:00.000Z"),
    });
    mocks.transaction.bankSyncRun.findFirst.mockResolvedValue({ id: "historical-run" });

    await expect(
      saveTreasuryAccount({
        holdedAccountId: account.id,
        importStartDate: "2026-06-18",
        configuredById: "administrator-1",
      }),
    ).rejects.toMatchObject({ code: "start_date_locked" });
    expect(mocks.transaction.holdedTreasuryAccount.updateMany).not.toHaveBeenCalled();
  });

  it("denies an operator before resolving a credential or provider account", async () => {
    mocks.requireBankingActor.mockRejectedValue(
      new BankingAuthorizationError("forbidden"),
    );
    const formData = new FormData();
    formData.set("holdedAccountId", "000000000000000000000001");
    formData.set("importStartDate", "2026-06-18");

    await expect(
      saveTreasuryAccountAction({ status: "idle" }, formData),
    ).resolves.toEqual({ status: "error", reason: "forbidden" });
    expect(mocks.requireBankingActor).toHaveBeenCalledWith("ADMINISTRATOR");
    expect(mocks.resolveIntegration).not.toHaveBeenCalled();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("renders only eligible choices, a 90-day default, and no credential input", () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const eligible = fixtures.account({ name: "Eligible account" });
    const archived = fixtures.account({ name: "Archived account", archived: true });
    const nonEur = fixtures.account({ name: "Dollar account", currency: "USD" });

    render(
      <TreasuryAccountSettings
        status="ok"
        options={[eligible, archived, nonEur]}
        current={null}
        defaultImportStartDate="2026-06-18"
        action={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("option", { name: "Eligible account" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Archived account" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Dollar account" })).toBeNull();
    expect(
      screen.getByLabelText("Bookings.settings.treasury.importStartDate"),
    ).toHaveValue("2026-06-18");
    expect(screen.queryByLabelText(/credential|api key/iu)).toBeNull();
    expect(document.body.textContent).not.toContain("stored-secret");
  });

  it("keeps a historical start date disabled and submits it through a hidden field", async () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account({ name: "Historical account" });
    const action = vi.fn().mockResolvedValue({ status: "saved" });
    const user = userEvent.setup();

    render(
      <TreasuryAccountSettings
        status="ok"
        options={[account]}
        current={{
          holdedAccountId: account.id,
          importStartDate: "2026-05-01",
          importStartDateLocked: true,
        }}
        defaultImportStartDate="2026-06-18"
        action={action}
      />,
    );

    const date = screen.getByLabelText(
      "Bookings.settings.treasury.importStartDate",
    );
    expect(date).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Bookings.settings.treasury.save" }));

    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    const submitted = action.mock.calls[0][1] as FormData;
    expect(submitted.get("importStartDate")).toBe("2026-05-01");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Bookings.settings.treasury.saved",
    );
  });
});