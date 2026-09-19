import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  BANK_PAYMENT_CANDIDATE_LIMIT,
  BANK_SYNC_INTERVAL_MS,
  BANK_SYNC_MANUAL_COOLDOWN_MS,
  bankMovementFiltersSchema,
} from "@/modules/banking/schema";
import {
  bookingPaymentStartDate,
  estimateNumber,
  expectedPaymentMinor,
  hasEstimateReference,
  isBookingPaymentCandidate,
  paymentAmountBounds,
} from "@/modules/banking/services/payment-matching";
import type {
  BankIntegrationState,
  BankMovementCurrencyTotals,
  BankMovementFilters,
  BankMovementPage,
  BookingPaymentCandidate,
  BankSyncIncidentSummary,
  BankSynchronizationSummary,
  BankSyncRunSummary,
} from "@/modules/banking/types";

export type {
  BankIntegrationState,
  BankMovementCurrencyTotals,
  BankMovementFilters,
  BankMovementPage,
  BankMovementRow,
  BankSyncIncidentSummary,
  BankSynchronizationSummary,
  BankSyncRunSummary,
  ReconciliationProposalSummary,
} from "@/modules/banking/types";

export const BANK_MOVEMENT_PAGE_SIZE = 50;

const proposalStatuses = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  DISMISSED: "dismissed",
  INVALIDATED: "invalidated",
} as const;

export function projectBankSyncIncident(incident: {
  code: BankSyncIncidentSummary["code"];
  pageNumber: number;
  itemIndex: number | null;
}): BankSyncIncidentSummary {
  return {
    code: incident.code,
    pageNumber: incident.pageNumber,
    itemIndex: incident.itemIndex,
  };
}

export function resolveBankIntegrationState(input: {
  configured: boolean;
  latestRunStatus: BankSyncRunSummary["status"] | null;
  latestSuccessfulAt: Date | null;
  now: Date;
}): BankIntegrationState {
  if (!input.configured) return "unconfigured";
  if (input.latestRunStatus === "RETRYING") return "retrying";
  if (input.latestRunStatus === "PARTIAL") return "partial";
  if (input.latestRunStatus === "FAILED") return "failed";

  const active =
    input.latestRunStatus === "QUEUED" || input.latestRunStatus === "RUNNING";
  if (active && !input.latestSuccessfulAt) return "initial_active";
  if (active) return "healthy";

  if (!input.latestSuccessfulAt) return "stale";
  return input.now.getTime() - input.latestSuccessfulAt.getTime() >
    BANK_SYNC_INTERVAL_MS
    ? "stale"
    : "healthy";
}

export async function listBookingPaymentCandidates(
  bookingRequestId: string,
): Promise<BookingPaymentCandidate[]> {
  const booking = await db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    select: {
      state: true,
      decidedAt: true,
      advanceCents: true,
      depositCents: true,
      documents: {
        where: { type: "ESTIMATE" },
        take: 1,
        select: { documentNumber: true, issuedAt: true },
      },
    },
  });
  if (!booking || booking.state !== "AWAITING_PAYMENT") {
    return [];
  }

  const paymentStartDate = bookingPaymentStartDate(booking);
  if (!paymentStartDate) return [];
  const expected = expectedPaymentMinor(booking);
  if (expected <= BigInt(0)) return [];
  const bounds = paymentAmountBounds(expected);
  const rows = await db.bankMovement.findMany({
    where: {
      direction: "INCOME",
      currency: "EUR",
      bookingDate: { gte: paymentStartDate },
      amountMinor: { gte: bounds.minimum, lte: bounds.maximum },
      payment: null,
      proposals: {
        none: {
          bookingRequestId,
          status: { in: ["DISMISSED", "INVALIDATED"] },
        },
      },
    },
    select: {
      id: true,
      holdedMovementId: true,
      bookingDate: true,
      narrative: true,
      amountMinor: true,
      currency: true,
      direction: true,
    },
  });
  const documentNumber = estimateNumber(booking);

  return rows
    .filter((movement) => isBookingPaymentCandidate(movement, booking))
    .map((movement) => ({
      movementId: movement.id,
      holdedMovementId: movement.holdedMovementId,
      bookingDate: serializedBankDate(movement.bookingDate)!,
      narrative: movement.narrative,
      amountMinor: movement.amountMinor,
      difference:
        movement.amountMinor >= expected
          ? movement.amountMinor - expected
          : expected - movement.amountMinor,
      currency: movement.currency as "EUR",
      estimateReferenceFound: hasEstimateReference(
        movement.narrative,
        documentNumber,
      ),
    }))
    .sort((left, right) => {
      if (left.estimateReferenceFound !== right.estimateReferenceFound) {
        return left.estimateReferenceFound ? -1 : 1;
      }
      if (left.difference !== right.difference) {
        return left.difference < right.difference ? -1 : 1;
      }
      const byDate = right.bookingDate.localeCompare(left.bookingDate);
      return byDate || left.holdedMovementId.localeCompare(right.holdedMovementId);
    })
    .slice(0, BANK_PAYMENT_CANDIDATE_LIMIT)
    .map(({ difference, ...candidate }) => ({
      movementId: candidate.movementId,
      bookingDate: candidate.bookingDate,
      narrative: candidate.narrative,
      amountMinor: candidate.amountMinor.toString(),
      expectedAmountMinor: expected.toString(),
      differenceMinor: difference.toString(),
      currency: candidate.currency,
      estimateReferenceFound: candidate.estimateReferenceFound,
    }));
}

export class BankMovementQueryError extends Error {
  constructor(readonly code: "invalid_filter") {
    super(code);
    this.name = "BankMovementQueryError";
  }
}

function bankDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function serializedBankDate(value: Date | null) {
  return value?.toISOString().slice(0, 10) ?? null;
}

function isNonterminalRun(status: BankSyncRunSummary["status"] | undefined) {
  return status === "QUEUED" || status === "RUNNING" || status === "RETRYING";
}

export async function queryBankMovements(
  filters: BankMovementFilters,
  options: { now?: Date } = {},
): Promise<BankMovementPage> {
  const parsed = bankMovementFiltersSchema.parse(filters);
  const now = options.now ?? new Date();
  const [
    accountRows,
    currencyRows,
    activeAccount,
    latestManualRun,
    pendingProposalCount,
  ] = await Promise.all([
    db.holdedTreasuryAccount.findMany({
      orderBy: [{ displayName: "asc" }, { holdedAccountId: "asc" }],
      select: { holdedAccountId: true, displayName: true },
    }),
    db.bankMovement.findMany({
      distinct: ["currency"],
      orderBy: { currency: "asc" },
      select: { currency: true },
    }),
    db.holdedTreasuryAccount.findFirst({
      where: { active: true },
      select: {
        id: true,
        lastSuccessfulAt: true,
        syncRuns: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            id: true,
            status: true,
            trigger: true,
            pageCount: true,
            itemCount: true,
            insertedCount: true,
            updatedCount: true,
            unchangedCount: true,
            incidentCount: true,
            attemptCount: true,
            failureCode: true,
            createdAt: true,
            startedAt: true,
            nextAttemptAt: true,
            finishedAt: true,
            incidents: {
              orderBy: [
                { pageNumber: "asc" },
                { itemIndex: "asc" },
                { id: "asc" },
              ],
              select: {
                code: true,
                pageNumber: true,
                itemIndex: true,
              },
            },
          },
        },
      },
    }),
    db.bankSyncRun.findFirst({
      where: { trigger: "MANUAL", account: { active: true } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true },
    }),
    db.bankReconciliationProposal.count({ where: { status: "PENDING" } }),
  ]);
  const accounts = accountRows.map((account) => ({
    id: account.holdedAccountId,
    name: account.displayName,
  }));
  const currencies = currencyRows.map(({ currency }) => currency);
  const latestRun = activeAccount?.syncRuns[0] ?? null;
  const manualRefreshAvailableAt = latestManualRun
    ? new Date(
        latestManualRun.createdAt.getTime() + BANK_SYNC_MANUAL_COOLDOWN_MS,
      )
    : null;
  const manualCooldownActive = Boolean(
    manualRefreshAvailableAt && manualRefreshAvailableAt > now,
  );
  const synchronization: BankSynchronizationSummary = {
    configured: Boolean(activeAccount),
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          trigger: latestRun.trigger,
          pageCount: latestRun.pageCount,
          itemCount: latestRun.itemCount,
          insertedCount: latestRun.insertedCount,
          updatedCount: latestRun.updatedCount,
          unchangedCount: latestRun.unchangedCount,
          incidentCount: latestRun.incidentCount,
          attemptCount: latestRun.attemptCount,
          failureCode: latestRun.failureCode,
          createdAt: latestRun.createdAt.toISOString(),
          startedAt: latestRun.startedAt?.toISOString() ?? null,
          nextAttemptAt: latestRun.nextAttemptAt?.toISOString() ?? null,
          finishedAt: latestRun.finishedAt?.toISOString() ?? null,
          retryEligible:
            latestRun.status === "PARTIAL" || latestRun.status === "FAILED",
        }
      : null,
    latestSuccessfulAt: activeAccount?.lastSuccessfulAt?.toISOString() ?? null,
    incidents: latestRun?.incidents.map(projectBankSyncIncident) ?? [],
    pendingProposalCount,
    integrationState: resolveBankIntegrationState({
      configured: Boolean(activeAccount),
      latestRunStatus: latestRun?.status ?? null,
      latestSuccessfulAt: activeAccount?.lastSuccessfulAt ?? null,
      now,
    }),
    manualRefreshAllowed: Boolean(
      activeAccount && !isNonterminalRun(latestRun?.status) && !manualCooldownActive,
    ),
    manualRefreshAvailableAt: manualCooldownActive
      ? manualRefreshAvailableAt?.toISOString() ?? null
      : null,
  };

  if (
    (parsed.account && !accounts.some(({ id }) => id === parsed.account)) ||
    (parsed.currency && !currencies.includes(parsed.currency))
  ) {
    throw new BankMovementQueryError("invalid_filter");
  }

  const where: Prisma.BankMovementWhereInput = {
    ...(parsed.direction !== "all"
      ? { direction: parsed.direction === "income" ? "INCOME" : "EXPENSE" }
      : {}),
    ...(parsed.from || parsed.to
      ? {
          bookingDate: {
            ...(parsed.from ? { gte: bankDate(parsed.from) } : {}),
            ...(parsed.to ? { lte: bankDate(parsed.to) } : {}),
          },
        }
      : {}),
    ...(parsed.account
      ? { account: { holdedAccountId: parsed.account } }
      : {}),
    ...(parsed.currency ? { currency: parsed.currency } : {}),
    ...(parsed.q
      ? { narrative: { contains: parsed.q, mode: "insensitive" } }
      : {}),
  };

  const [rows, totalRows, groupedTotals] = await Promise.all([
    db.bankMovement.findMany({
      where,
      orderBy: [{ bookingDate: "desc" }, { holdedMovementId: "asc" }],
      skip: (parsed.page - 1) * BANK_MOVEMENT_PAGE_SIZE,
      take: BANK_MOVEMENT_PAGE_SIZE,
      select: {
        id: true,
        bookingDate: true,
        valueDate: true,
        narrative: true,
        amountMinor: true,
        currency: true,
        direction: true,
        payment: { select: { id: true } },
        account: { select: { holdedAccountId: true, displayName: true } },
        proposals: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            status: true,
            movementId: true,
            bookingRequestId: true,
            createdAt: true,
            decidedAt: true,
            decidedBy: { select: { name: true, email: true } },
            bookingRequest: {
              select: {
                documents: {
                  where: { type: "ESTIMATE" },
                  take: 1,
                  select: { documentNumber: true },
                },
              },
            },
          },
        },
      },
    }),
    db.bankMovement.count({ where }),
    db.bankMovement.groupBy({
      by: ["currency", "direction"],
      where,
      _sum: { amountMinor: true },
    }),
  ]);

  const totalsByCurrency = new Map<string, BankMovementCurrencyTotals>();
  for (const group of groupedTotals) {
    const totals = totalsByCurrency.get(group.currency) ?? {
      currency: group.currency,
      incomeMinor: "0",
      expenseMinor: "0",
    };
    const amount = group._sum.amountMinor ?? BigInt(0);
    if (group.direction === "INCOME") totals.incomeMinor = amount.toString();
    else totals.expenseMinor = (-amount).toString();
    totalsByCurrency.set(group.currency, totals);
  }

  return {
    rows: rows.map((row) => ({
      id: row.id,
      date: serializedBankDate(row.bookingDate)!,
      valueDate: serializedBankDate(row.valueDate),
      concept: row.narrative,
      reference: row.narrative,
      counterparty: null,
      account: {
        id: row.account.holdedAccountId,
        name: row.account.displayName,
      },
      amountMinor: row.amountMinor.toString(),
      currency: row.currency,
      status: row.payment ? "reconciled" : "pending",
      direction: row.direction === "INCOME" ? "income" : "expense",
      proposals: row.proposals.map((proposal) => ({
        id: proposal.id,
        status: proposalStatuses[proposal.status],
        movementId: proposal.movementId,
        bookingRequestId: proposal.bookingRequestId,
        estimateNumber:
          proposal.bookingRequest.documents[0]?.documentNumber ?? "",
        amountMinor: row.amountMinor.toString(),
        currency: row.currency,
        movementDate: serializedBankDate(row.bookingDate)!,
        narrative: row.narrative,
        createdAt: proposal.createdAt.toISOString(),
        decidedAt: proposal.decidedAt?.toISOString() ?? null,
        decidedByDisplay:
          proposal.decidedBy?.name?.trim() ||
          proposal.decidedBy?.email ||
          null,
      })),
    })),
    totalRows,
    page: parsed.page,
    pageSize: BANK_MOVEMENT_PAGE_SIZE,
    totals: [...totalsByCurrency.values()].toSorted((left, right) =>
      left.currency.localeCompare(right.currency),
    ),
    accounts,
    currencies,
    synchronization,
  };
}