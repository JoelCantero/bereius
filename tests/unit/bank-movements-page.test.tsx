import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  replace: vi.fn(),
  refresh: vi.fn(),
  requireBankingActor: vi.fn(),
  queryBankMovements: vi.fn(),
  confirmBookingCandidate: vi.fn(),
  dismissBookingCandidate: vi.fn(),
  confirmProposal: vi.fn(),
  dismissProposal: vi.fn(),
  revalidatePath: vi.fn(),
  requestManualBankSync: vi.fn(),
  setRequestLocale: vi.fn(),
}));

const labels: Record<string, string> = {
  title: "Bank movements",
  description: "Imported Holded movements",
  invalidFilters: "Some filters are invalid.",
  clearFilters: "Clear filters",
  empty: "No bank movements match these filters.",
  loading: "Loading bank movements",
  "filters.direction": "Direction",
  "filters.from": "From",
  "filters.to": "To",
  "filters.account": "Account",
  "filters.currency": "Currency",
  "filters.search": "Search",
  "filters.all": "All",
  "directions.income": "Income",
  "directions.expense": "Expense",
  "statuses.pending": "Pending",
  "statuses.reconciled": "Reconciled",
  "table.caption": "Imported bank movements",
  "table.date": "Date",
  "table.valueDate": "Value date",
  "table.concept": "Concept",
  "table.reference": "Reference",
  "table.counterparty": "Counterparty",
  "table.account": "Account",
  "table.amount": "Amount",
  "table.currency": "Currency",
  "table.status": "Status",
  "table.direction": "Direction",
  emptyValue: "Not available",
  "pagination.previous": "Previous page",
  "pagination.next": "Next page",
  "pagination.summary": "Page {page} of {pages}",
  "proposals.title": "Reconciliation proposal",
  "proposals.estimate": "Estimate {number}",
  "proposals.pending": "Pending review",
  "proposals.confirmed": "Confirmed",
  "proposals.dismissed": "Dismissed",
  "proposals.invalidated": "Invalidated",
  "proposals.confirm": "Confirm payment",
  "proposals.dismiss": "Dismiss proposal",
  "proposals.confirmedAnnouncement": "Payment confirmed.",
  "proposals.dismissedAnnouncement": "Proposal dismissed.",
  "proposals.errors.not_found": "The proposal is no longer available.",
  "synchronization.title": "Holded synchronization",
  "synchronization.status.queued": "Waiting to synchronize",
  "synchronization.status.running": "Synchronization in progress",
  "synchronization.status.retrying": "Waiting to retry",
  "synchronization.status.succeeded": "Synchronization complete",
  "synchronization.status.partial": "Synchronization partially complete",
  "synchronization.status.failed": "Synchronization failed",
  "synchronization.state.unconfigured": "Configure a treasury account to synchronize.",
  "synchronization.state.initial_active": "Initial synchronization is in progress.",
  "synchronization.state.healthy": "Bank data is current.",
  "synchronization.state.stale": "Bank data may be out of date.",
  "synchronization.state.retrying": "Holded is temporarily unavailable; retry is scheduled.",
  "synchronization.state.partial": "Some pages or movements need review.",
  "synchronization.state.failed": "The latest synchronization did not import a page.",
  "synchronization.refresh": "Refresh movements",
  "synchronization.retry": "Retry synchronization",
  "synchronization.refreshing": "Requesting refresh",
  "synchronization.cooldown": "Refresh will be available shortly.",
  "synchronization.accepted": "Refresh accepted.",
  "synchronization.alreadyRunning": "A synchronization is already active.",
  "synchronization.lastSuccess": "Last successful synchronization: {date}",
  "synchronization.finishedAt": "Latest attempt finished: {date}",
  "synchronization.nextAttempt": "Next retry: {date}",
  "synchronization.pendingProposals": "{count} pending proposals",
  "synchronization.retainedData": "Previously imported movements remain available for review.",
  "synchronization.expiryDeferred": "Unpaid bookings wait for a fresh complete scan.",
  "synchronization.progress.pages": "{count} pages",
  "synchronization.progress.items": "{count} items",
  "synchronization.progress.inserted": "{count} inserted",
  "synchronization.progress.updated": "{count} updated",
  "synchronization.progress.unchanged": "{count} unchanged",
  "synchronization.progress.incidents": "{count} incidents",
  "synchronization.incidents.MALFORMED_PAGE": "Malformed provider page",
  "synchronization.incidents.PROVIDER_UNAVAILABLE": "Holded was unavailable",
  "synchronization.incidentAtPage": "{reason} (page {page})",
  "synchronization.incidentAtItem": "{reason} (page {page}, item {item})",
  "synchronization.errors.rate_limited": "Wait before requesting another refresh.",
};

function translate(key: string, values?: Record<string, string | number>) {
  let value = labels[key] ?? key;
  for (const [name, replacement] of Object.entries(values ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("next-intl/server", () => ({
  getTranslations: () => translate,
  setRequestLocale: mocks.setRequestLocale,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
  usePathname: () => "/bank-movements",
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock("@/modules/banking/authorization", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/banking/authorization")>();
  return { ...original, requireBankingActor: mocks.requireBankingActor };
});
vi.mock("@/modules/banking/services/queries", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/banking/services/queries")>();
  return { ...original, queryBankMovements: mocks.queryBankMovements };
});
vi.mock("@/modules/banking/services/reconciliation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/banking/services/reconciliation")>();
  return {
    ...original,
    confirmBookingPaymentCandidate: mocks.confirmBookingCandidate,
    dismissBookingPaymentCandidate: mocks.dismissBookingCandidate,
    confirmReconciliationProposal: mocks.confirmProposal,
    dismissReconciliationProposal: mocks.dismissProposal,
  };
});
vi.mock("@/modules/banking/services/synchronization", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/banking/services/synchronization")>();
  return { ...original, requestManualBankSync: mocks.requestManualBankSync };
});
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import BankMovementsPage, {
  generateMetadata,
} from "@/app/[locale]/(console)/bank-movements/page";
import BankMovementsLoading from "@/app/[locale]/(console)/bank-movements/loading";
import { BankingAuthorizationError } from "@/modules/banking/authorization";
import { MovementFilters } from "@/modules/banking/components/movement-filters";
import { MovementTable } from "@/modules/banking/components/movement-table";
import {
  confirmBookingPaymentCandidateAction,
  confirmReconciliationProposalAction,
  dismissBookingPaymentCandidateAction,
  type ReconciliationActionState,
} from "@/modules/banking/actions/reconciliation";
import {
  requestBankSyncAction,
  type BankSyncActionState,
} from "@/modules/banking/actions/synchronization";
import { ReconciliationActions } from "@/modules/banking/components/reconciliation-actions";
import {
  BANK_SYNC_POLL_INTERVAL_MS,
  SynchronizationControl,
} from "@/modules/banking/components/synchronization-control";
import { ReconciliationError } from "@/modules/banking/services/reconciliation";
import type {
  BankMovementFilters,
  BankMovementPage,
  BankMovementRow,
  ReconciliationProposalSummary,
} from "@/modules/banking/services/queries";
import {
  resolveBankIntegrationState,
  type BankSynchronizationSummary,
  type BankSyncRunSummary,
} from "@/modules/banking/services/queries";

const defaultFilters: BankMovementFilters = {
  direction: "all",
  from: undefined,
  to: undefined,
  account: undefined,
  currency: undefined,
  q: "",
  page: 1,
};

const movement: BankMovementRow = {
  id: "local-movement-id",
  date: "2026-09-12",
  valueDate: null,
  concept: null,
  reference: null,
  counterparty: null,
  account: { id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Synthetic account" },
  amountMinor: "-1234",
  currency: "EUR",
  status: "pending",
  direction: "expense",
  proposals: [],
};

const reconciledIncome: BankMovementRow = {
  ...movement,
  id: "local-reconciled-income-id",
  amountMinor: "4321",
  status: "reconciled",
  direction: "income",
};

const proposal: ReconciliationProposalSummary = {
  id: "local-proposal-id",
  status: "pending",
  movementId: movement.id,
  bookingRequestId: "local-booking-id",
  estimateNumber: "EST-63200",
  amountMinor: "63200",
  currency: "EUR",
  movementDate: "2026-09-12",
  narrative: "Synthetic transfer EST-63200 received",
  createdAt: "2026-09-16T12:00:00.000Z",
  decidedAt: null,
  decidedByDisplay: null,
};

function result(overrides: Partial<BankMovementPage> = {}): BankMovementPage {
  return {
    rows: [movement],
    totalRows: 1,
    page: 1,
    pageSize: 50,
    totals: [{ currency: "EUR", incomeMinor: "0", expenseMinor: "1234" }],
    accounts: [movement.account],
    currencies: ["EUR"],
    synchronization: synchronization(),
    ...overrides,
  };
}

function synchronization(
  overrides: Partial<BankSynchronizationSummary> = {},
): BankSynchronizationSummary {
  return {
    configured: true,
    latestRun: null,
    latestSuccessfulAt: "2026-09-16T12:00:00.000Z",
    incidents: [],
    pendingProposalCount: 0,
    integrationState: "healthy",
    manualRefreshAllowed: true,
    manualRefreshAvailableAt: null,
    ...overrides,
  };
}

function syncRun(
  status: BankSyncRunSummary["status"],
  overrides: Partial<BankSyncRunSummary> = {},
): BankSyncRunSummary {
  return {
    id: "clocalsyncrun00000000001",
    status,
    trigger: "MANUAL",
    pageCount: 2,
    itemCount: 125,
    insertedCount: 10,
    updatedCount: 3,
    unchangedCount: 108,
    incidentCount: 4,
    attemptCount: 2,
    failureCode: null,
    createdAt: "2026-09-16T12:00:00.000Z",
    startedAt: "2026-09-16T12:00:05.000Z",
    nextAttemptAt: status === "RETRYING" ? "2026-09-16T12:01:00.000Z" : null,
    finishedAt: ["SUCCEEDED", "PARTIAL", "FAILED"].includes(status)
      ? "2026-09-16T12:00:30.000Z"
      : null,
    retryEligible: status === "PARTIAL" || status === "FAILED",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function pageProps(
  locale: "en" | "es" | "ca" = "en",
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  return {
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(searchParams),
  };
}

describe("bank movements page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBankingActor.mockResolvedValue({
      userId: "synthetic-operator",
      role: "OPERATOR",
    });
    mocks.queryBankMovements.mockResolvedValue(result());
    window.history.replaceState({}, "", "/bank-movements");
  });

  it.each([
    ["en", "/login?callbackUrl=%2Fbank-movements"],
    ["es", "/es/login?callbackUrl=%2Fbank-movements"],
    ["ca", "/ca/login?callbackUrl=%2Fbank-movements"],
  ] as const)("redirects a signed-out %s request safely", async (locale, path) => {
    mocks.requireBankingActor.mockRejectedValue(
      new BankingAuthorizationError("unauthenticated"),
    );

    await expect(BankMovementsPage(pageProps(locale))).rejects.toThrow(
      `REDIRECT:${path}`,
    );
    expect(mocks.queryBankMovements).not.toHaveBeenCalled();
  });

  it("sends an authenticated forbidden actor to the safe console fallback", async () => {
    mocks.requireBankingActor.mockRejectedValue(
      new BankingAuthorizationError("forbidden"),
    );

    await expect(BankMovementsPage(pageProps())).rejects.toThrow(
      "REDIRECT:/bookings",
    );
    expect(mocks.queryBankMovements).not.toHaveBeenCalled();
  });

  it.each(["OPERATOR", "ADMINISTRATOR"] as const)(
    "allows an active %s to inspect stored movements",
    async (role) => {
      mocks.requireBankingActor.mockResolvedValue({ userId: "actor-id", role });

      render(await BankMovementsPage(pageProps()));

      expect(screen.getByRole("heading", { name: "Bank movements" })).toBeVisible();
      expect(screen.getByRole("table", { name: "Imported bank movements" })).toBeVisible();
      expect(mocks.queryBankMovements).toHaveBeenCalledWith(defaultFilters);
    },
  );

  it.each(["en", "es", "ca"] as const)(
    "marks the %s bank-movements page private and non-indexable",
    async (locale) => {
      await expect(generateMetadata(pageProps(locale))).resolves.toMatchObject({
        title: "Bank movements",
        description: "Imported Holded movements",
        robots: { index: false, follow: false },
      });
    },
  );

  it("rejects invalid filters without issuing a database query", async () => {
    render(
      await BankMovementsPage(
        pageProps("en", { direction: "sideways", page: "999999999999999999999" }),
      ),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some filters are invalid.",
    );
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/bank-movements",
    );
    expect(mocks.queryBankMovements).not.toHaveBeenCalled();
  });

  it("shows an empty filtered result with a clear action", async () => {
    mocks.queryBankMovements.mockResolvedValue(
      result({ rows: [], totalRows: 0, totals: [] }),
    );

    render(await BankMovementsPage(pageProps("en", { q: "missing" })));

    expect(screen.getByText("No bank movements match these filters.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/bank-movements",
    );
  });

  it("keeps earlier movement rows available while synchronization is degraded", async () => {
    mocks.queryBankMovements.mockResolvedValue(
      result({
        synchronization: synchronization({
          latestRun: syncRun("FAILED", {
            failureCode: "PROVIDER_UNAVAILABLE",
          }),
          integrationState: "failed",
          manualRefreshAllowed: false,
          manualRefreshAvailableAt: "2026-09-16T12:01:00.000Z",
        }),
      }),
    );

    render(await BankMovementsPage(pageProps()));

    expect(
      screen.getByRole("heading", { name: "Holded synchronization" }),
    ).toBeVisible();
    expect(
      screen.getByText("The latest synchronization did not import a page."),
    ).toBeVisible();
    expect(screen.getByRole("row", { name: /Expense/u })).toBeVisible();
  });

  it("paginates while preserving validated active filters", async () => {
    mocks.queryBankMovements.mockResolvedValue(
      result({ totalRows: 101, page: 2 }),
    );

    render(
      await BankMovementsPage(
        pageProps("es", { direction: "income", q: "synthetic", page: "2" }),
      ),
    );

    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "?direction=income&q=synthetic&page=1",
    );
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "?direction=income&q=synthetic&page=3",
    );
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
  });
});

describe("bank movement controls and presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(
      {},
      "",
      "/bank-movements?direction=income&q=synthetic&page=4",
    );
  });

  it("resets pagination when a filter changes or all filters clear", async () => {
    render(
      <MovementFilters
        filters={{ ...defaultFilters, direction: "income", q: "synthetic", page: 4 }}
        accounts={[movement.account]}
        currencies={["EUR"]}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText("Direction"), "expense");
    expect(mocks.replace).toHaveBeenLastCalledWith(
      "/bank-movements?direction=expense&q=synthetic",
      { scroll: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(mocks.replace).toHaveBeenLastCalledWith("/bank-movements", {
      scroll: false,
    });
  });

  it("renders localized semantic direction and reconciliation badges", () => {
    render(
      <MovementTable
        rows={[movement, reconciledIncome]}
        locale="en"
        confirmAction={vi.fn()}
        dismissAction={vi.fn()}
      />,
    );

    const expenseRow = screen.getByRole("row", { name: /Expense/u });
    expect(within(expenseRow).getByText("-€12.34")).toBeVisible();
    expect(within(expenseRow).getAllByText("Not available")).toHaveLength(2);
    for (const label of ["Expense", "Pending"]) {
      expect(within(expenseRow).getByText(label)).toHaveClass(
        "bg-red-100",
        "text-red-900",
        "dark:bg-red-950",
        "dark:text-red-200",
      );
    }

    const incomeRow = screen.getByRole("row", { name: /Income/u });
    expect(within(incomeRow).getByText("+€43.21")).toBeVisible();
    for (const label of ["Income", "Reconciled"]) {
      expect(within(incomeRow).getByText(label)).toHaveClass(
        "bg-emerald-100",
        "text-emerald-900",
        "dark:bg-emerald-950",
        "dark:text-emerald-200",
      );
    }

    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getByRole("columnheader", { name: "Value date" })).toBeVisible();
    for (const removed of ["Date", "Reference", "Counterparty", "Account", "Currency"]) {
      expect(
        screen.queryByRole("columnheader", { name: removed }),
      ).not.toBeInTheDocument();
    }
  });

  it("provides a stable, announced loading state", () => {
    render(<BankMovementsLoading />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading bank movements");
    expect(screen.getByRole("table", { name: "Imported bank movements" })).toBeVisible();
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getByRole("columnheader", { name: "Value date" })).toBeVisible();
    for (const removed of ["Date", "Reference", "Counterparty", "Account", "Currency"]) {
      expect(
        screen.queryByRole("columnheader", { name: removed }),
      ).not.toBeInTheDocument();
    }
  });
});

describe("reconciliation proposal controls", () => {
  const idle: ReconciliationActionState = { status: "idle" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBankingActor.mockResolvedValue({
      userId: "trusted-operator-id",
      role: "OPERATOR",
    });
  });

  it.each([
    ["pending", "Pending review"],
    ["confirmed", "Confirmed"],
    ["dismissed", "Dismissed"],
    ["invalidated", "Invalidated"],
  ] as const)("renders the %s proposal state", (status, expected) => {
    render(
      <ReconciliationActions
        proposal={{ ...proposal, status }}
        confirmAction={vi.fn()}
        dismissAction={vi.fn()}
      />,
    );

    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.getByText("Estimate EST-63200")).toBeVisible();
    if (status === "pending") {
      expect(screen.getByRole("button", { name: "Confirm payment" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Dismiss proposal" })).toBeEnabled();
    } else {
      expect(screen.queryByRole("button")).toBeNull();
    }
  });

  it("announces a confirmed action result", async () => {
    const confirmAction = vi.fn().mockResolvedValue({
      status: "confirmed",
      bookingRequestId: proposal.bookingRequestId,
    });
    render(
      <ReconciliationActions
        proposal={proposal}
        confirmAction={confirmAction}
        dismissAction={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Confirm payment" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Payment confirmed.");
    const submitted = confirmAction.mock.calls[0]?.[1] as FormData;
    expect([...submitted.entries()]).toEqual([["proposalId", proposal.id]]);
  });

  it("locks both decisions while one action is pending", async () => {
    let resolveAction!: (state: ReconciliationActionState) => void;
    const confirmAction = vi.fn(
      () =>
        new Promise<ReconciliationActionState>((resolve) => {
          resolveAction = resolve;
        }),
    );
    render(
      <ReconciliationActions
        proposal={proposal}
        confirmAction={confirmAction}
        dismissAction={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Confirm payment" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Dismiss proposal" })).toBeDisabled();
    });
    expect(confirmAction).toHaveBeenCalledTimes(1);

    resolveAction({ status: "confirmed", bookingRequestId: proposal.bookingRequestId });
    await screen.findByRole("status");
  });

  it("maps an unknown proposal to the same safe not-found result", async () => {
    mocks.confirmProposal.mockRejectedValue(new ReconciliationError("not_found"));
    const formData = new FormData();
    formData.set("proposalId", "cunknownlocalproposal000001");

    await expect(
      confirmReconciliationProposalAction(idle, formData),
    ).resolves.toEqual({ status: "error", reason: "not_found" });
    expect(mocks.confirmProposal).toHaveBeenCalledWith({
      proposalId: "cunknownlocalproposal000001",
      actorUserId: "trusted-operator-id",
    });
  });

  it("shows proposal context inside the authorized movement row", async () => {
    mocks.queryBankMovements.mockResolvedValue(
      result({ rows: [{ ...movement, proposals: [proposal] }] }),
    );

    render(await BankMovementsPage(pageProps()));

    expect(screen.getByText("Estimate EST-63200")).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm payment" })).toBeVisible();
  });
});

describe("booking payment candidate actions", () => {
  const idle: ReconciliationActionState = { status: "idle" };
  const bookingRequestId = "clocalbookingrequest000001";
  const movementId = "clocalbankmovement00000001";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBankingActor.mockResolvedValue({
      userId: "trusted-operator-id",
      role: "OPERATOR",
    });
  });

  it("confirms an allowlisted local pair as the trusted actor", async () => {
    mocks.confirmBookingCandidate.mockResolvedValue({ bookingRequestId });
    const formData = new FormData();
    formData.set("bookingRequestId", bookingRequestId);
    formData.set("movementId", movementId);
    formData.set("amountMinor", "1");
    formData.set("actorUserId", "untrusted-user-id");

    await expect(
      confirmBookingPaymentCandidateAction(idle, formData),
    ).resolves.toEqual({ status: "confirmed", bookingRequestId });
    expect(mocks.confirmBookingCandidate).toHaveBeenCalledWith({
      bookingRequestId,
      movementId,
      actorUserId: "trusted-operator-id",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/bank-movements");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/bookings");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/bookings/${bookingRequestId}`,
    );
  });

  it("dismisses the local pair without accepting a client actor", async () => {
    mocks.dismissBookingCandidate.mockResolvedValue(undefined);
    const formData = new FormData();
    formData.set("bookingRequestId", bookingRequestId);
    formData.set("movementId", movementId);
    formData.set("actorUserId", "untrusted-user-id");

    await expect(
      dismissBookingPaymentCandidateAction(idle, formData),
    ).resolves.toEqual({ status: "dismissed" });
    expect(mocks.dismissBookingCandidate).toHaveBeenCalledWith({
      bookingRequestId,
      movementId,
      actorUserId: "trusted-operator-id",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/bank-movements");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      `/bookings/${bookingRequestId}`,
    );
  });

  it("rejects an invalid pair before calling the domain service", async () => {
    const formData = new FormData();
    formData.set("bookingRequestId", "not-a-cuid");
    formData.set("movementId", movementId);

    await expect(
      confirmBookingPaymentCandidateAction(idle, formData),
    ).resolves.toEqual({ status: "error", reason: "invalid" });
    expect(mocks.confirmBookingCandidate).not.toHaveBeenCalled();
  });
});

describe("manual bank synchronization action", () => {
  const idle: BankSyncActionState = { status: "idle" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBankingActor.mockResolvedValue({
      userId: "trusted-operator-id",
      role: "OPERATOR",
    });
  });

  it.each([
    [true, "accepted"],
    [false, "already_running"],
  ] as const)("returns %s work as %s", async (created, status) => {
    mocks.requestManualBankSync.mockResolvedValue({
      runId: "clocalmanualrun000000001",
      accountId: "local-account-id",
      created,
    });

    await expect(requestBankSyncAction(idle, new FormData())).resolves.toEqual({
      status,
      runId: "clocalmanualrun000000001",
    });
    expect(mocks.requestManualBankSync).toHaveBeenCalledWith({
      requestedById: "trusted-operator-id",
      retryRunId: undefined,
    });
  });

  it("accepts only a local retry run id and derives the account server-side", async () => {
    mocks.requestManualBankSync.mockResolvedValue({
      runId: "clocalretriedrun00000001",
      accountId: "trusted-account-id",
      created: true,
    });
    const formData = new FormData();
    formData.set("retryRunId", "clocalfailedrun00000001");
    formData.set("accountId", "untrusted-account-id");
    formData.set("cursor", "untrusted-cursor");

    await expect(requestBankSyncAction(idle, formData)).resolves.toEqual({
      status: "accepted",
      runId: "clocalretriedrun00000001",
    });
    expect(mocks.requestManualBankSync).toHaveBeenCalledWith({
      requestedById: "trusted-operator-id",
      retryRunId: "clocalfailedrun00000001",
    });
  });

  it("returns a sanitized manual cooldown result", async () => {
    const { BankSyncRequestError } = await import(
      "@/modules/banking/services/synchronization"
    );
    mocks.requestManualBankSync.mockRejectedValue(
      new BankSyncRequestError("rate_limited"),
    );

    await expect(requestBankSyncAction(idle, new FormData())).resolves.toEqual({
      status: "error",
      reason: "rate_limited",
    });
  });
});

describe("bank synchronization status", () => {
  const idleAction = vi.fn(async (): Promise<BankSyncActionState> => ({
    status: "idle",
  }));
  const boundary = new Date("2026-09-16T18:00:00.000Z");

  it.each([
    [false, null, null, "unconfigured"],
    [true, "QUEUED", null, "initial_active"],
    [true, "RUNNING", null, "initial_active"],
    [true, null, null, "stale"],
    [true, "RETRYING", boundary, "retrying"],
    [true, "PARTIAL", boundary, "partial"],
    [true, "FAILED", boundary, "failed"],
  ] as const)(
    "derives configured=%s run=%s success=%s as %s",
    (configured, latestRunStatus, latestSuccessfulAt, expected) => {
      expect(
        resolveBankIntegrationState({
          configured,
          latestRunStatus,
          latestSuccessfulAt,
          now: boundary,
        }),
      ).toBe(expected);
    },
  );

  it("degrades only when the latest success is more than six hours old", () => {
    expect(
      resolveBankIntegrationState({
        configured: true,
        latestRunStatus: "SUCCEEDED",
        latestSuccessfulAt: new Date("2026-09-16T12:00:00.000Z"),
        now: boundary,
      }),
    ).toBe("healthy");
    expect(
      resolveBankIntegrationState({
        configured: true,
        latestRunStatus: null,
        latestSuccessfulAt: new Date("2026-09-16T11:59:59.999Z"),
        now: boundary,
      }),
    ).toBe("stale");
  });

  it.each([
    ["QUEUED", "Waiting to synchronize"],
    ["RUNNING", "Synchronization in progress"],
    ["RETRYING", "Waiting to retry"],
    ["SUCCEEDED", "Synchronization complete"],
    ["PARTIAL", "Synchronization partially complete"],
    ["FAILED", "Synchronization failed"],
  ] as const)("renders %s progress honestly", (status, expected) => {
    render(
      <SynchronizationControl
        synchronization={synchronization({
          latestRun: syncRun(status),
          integrationState:
            status === "RETRYING"
              ? "retrying"
              : status === "PARTIAL"
                ? "partial"
                : status === "FAILED"
                  ? "failed"
                  : status === "QUEUED" || status === "RUNNING"
                    ? "initial_active"
                    : "healthy",
          pendingProposalCount: 2,
        })}
        action={idleAction}
      />,
    );

    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.getByText("2 pages")).toBeVisible();
    expect(screen.getByText("125 items")).toBeVisible();
    expect(screen.getByText("10 inserted")).toBeVisible();
    expect(screen.getByText("3 updated")).toBeVisible();
    expect(screen.getByText("108 unchanged")).toBeVisible();
    expect(screen.getByText("4 incidents")).toBeVisible();
    expect(screen.getByText("2 pending proposals")).toBeVisible();
  });

  it("distinguishes unconfigured setup from an initial active run", () => {
    const { rerender } = render(
      <SynchronizationControl
        synchronization={synchronization({
          configured: false,
          latestSuccessfulAt: null,
          integrationState: "unconfigured",
          manualRefreshAllowed: false,
        })}
        action={idleAction}
      />,
    );
    expect(
      screen.getByText("Configure a treasury account to synchronize."),
    ).toBeVisible();

    rerender(
      <SynchronizationControl
        synchronization={synchronization({
          latestRun: syncRun("QUEUED", { pageCount: 0, itemCount: 0 }),
          latestSuccessfulAt: null,
          integrationState: "initial_active",
          manualRefreshAllowed: false,
        })}
        action={idleAction}
      />,
    );
    expect(screen.getByText("Initial synchronization is in progress.")).toBeVisible();
  });

  it("shows latest success and sanitized incidents while retained rows remain visible", () => {
    render(
      <>
        <SynchronizationControl
          synchronization={synchronization({
            latestRun: syncRun("PARTIAL"),
            integrationState: "partial",
            incidents: [
              { code: "MALFORMED_PAGE", pageNumber: 2, itemIndex: null },
            ],
          })}
          action={idleAction}
        />
        <MovementTable
          rows={[movement]}
          locale="en"
          confirmAction={vi.fn()}
          dismissAction={vi.fn()}
        />
      </>,
    );

    expect(
      screen.getByText(/Last successful synchronization:/u),
    ).toBeVisible();
    expect(screen.getByText("Malformed provider page (page 2)")).toBeVisible();
    expect(screen.getByRole("row", { name: /Expense/u })).toBeVisible();
  });

  it("polls only while work is active and cleans up on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <SynchronizationControl
        synchronization={synchronization({ latestRun: syncRun("RUNNING") })}
        action={idleAction}
      />,
    );

    await act(() => vi.advanceTimersByTimeAsync(BANK_SYNC_POLL_INTERVAL_MS));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(BANK_SYNC_POLL_INTERVAL_MS * 2));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("submits a terminal retry with only its local run id", async () => {
    const action = vi.fn().mockResolvedValue({
      status: "accepted",
      runId: "clocalnewrun00000000001",
    });
    render(
      <SynchronizationControl
        synchronization={synchronization({
          latestRun: syncRun("FAILED"),
          integrationState: "failed",
        })}
        action={action}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Retry synchronization" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent("Refresh accepted.");
    const submitted = action.mock.calls[0]?.[1] as FormData;
    expect([...submitted.entries()]).toEqual([
      ["retryRunId", "clocalsyncrun00000000001"],
    ]);
  });

  it("disables refresh during cooldown and reports the sanitized action result", async () => {
    const action = vi.fn().mockResolvedValue({
      status: "error",
      reason: "rate_limited",
    });
    const { rerender } = render(
      <SynchronizationControl
        synchronization={synchronization({
          manualRefreshAllowed: false,
          manualRefreshAvailableAt: "2026-09-16T12:01:00.000Z",
        })}
        action={action}
      />,
    );
    expect(screen.getByRole("button", { name: "Refresh movements" })).toBeDisabled();
    expect(screen.getByText("Refresh will be available shortly.")).toBeVisible();

    rerender(
      <SynchronizationControl
        synchronization={synchronization()}
        action={action}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh movements" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wait before requesting another refresh.",
    );
  });
});