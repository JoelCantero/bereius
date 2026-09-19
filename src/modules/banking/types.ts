import type { BankSyncIncidentCode } from "@/modules/banking/schema";

export type { BankMovementFilters } from "@/modules/banking/schema";

export type ReconciliationActionState =
  | { status: "idle" }
  | { status: "confirmed"; bookingRequestId: string }
  | { status: "dismissed" }
  | {
      status: "error";
      reason:
        | "unauthenticated"
        | "forbidden"
        | "invalid"
        | "not_found"
        | "state_changed"
        | "proposal_changed"
        | "movement_ineligible"
        | "amount_mismatch"
        | "movement_already_used"
        | "unknown";
    };

export type TreasuryAccountSettingsActionState =
  | { status: "idle" }
  | { status: "saved" }
  | {
      status: "error";
      reason:
        | "unauthenticated"
        | "forbidden"
        | "invalid"
        | "not_configured"
        | "account_unavailable"
        | "start_date_locked"
        | "connection"
        | "unknown";
    };

export type BankSyncActionState =
  | { status: "idle" }
  | { status: "accepted"; runId: string }
  | { status: "already_running"; runId: string }
  | {
      status: "error";
      reason:
        | "unauthenticated"
        | "forbidden"
        | "not_configured"
        | "rate_limited"
        | "invalid"
        | "unknown";
    };

export interface ReconciliationProposalSummary {
  id: string;
  status: "pending" | "confirmed" | "dismissed" | "invalidated";
  movementId: string;
  bookingRequestId: string;
  estimateNumber: string;
  amountMinor: string;
  currency: string;
  movementDate: string;
  narrative: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedByDisplay: string | null;
}

export interface BookingPaymentCandidate {
  movementId: string;
  bookingDate: string;
  narrative: string | null;
  amountMinor: string;
  expectedAmountMinor: string;
  differenceMinor: string;
  currency: "EUR";
  estimateReferenceFound: boolean;
}

export interface BankMovementRow {
  id: string;
  date: string;
  valueDate: string | null;
  concept: string | null;
  reference: string | null;
  counterparty: null;
  account: { id: string; name: string };
  amountMinor: string;
  currency: string;
  status: "pending" | "reconciled";
  direction: "income" | "expense";
  proposals: ReconciliationProposalSummary[];
}

export interface BankMovementCurrencyTotals {
  currency: string;
  incomeMinor: string;
  expenseMinor: string;
}

export type BankIntegrationState =
  | "unconfigured"
  | "initial_active"
  | "healthy"
  | "stale"
  | "retrying"
  | "partial"
  | "failed";

export interface BankSyncRunSummary {
  id: string;
  status: "QUEUED" | "RUNNING" | "RETRYING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
  trigger: "SCHEDULED" | "MANUAL" | "EXPIRY";
  pageCount: number;
  itemCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  incidentCount: number;
  attemptCount: number;
  failureCode: BankSyncIncidentCode | null;
  createdAt: string;
  startedAt: string | null;
  nextAttemptAt: string | null;
  finishedAt: string | null;
  retryEligible: boolean;
}

export interface BankSyncIncidentSummary {
  code: BankSyncIncidentCode;
  pageNumber: number;
  itemIndex: number | null;
}

export interface BankSynchronizationSummary {
  configured: boolean;
  latestRun: BankSyncRunSummary | null;
  latestSuccessfulAt: string | null;
  incidents: BankSyncIncidentSummary[];
  pendingProposalCount: number;
  integrationState: BankIntegrationState;
  manualRefreshAllowed: boolean;
  manualRefreshAvailableAt: string | null;
}

export interface BankMovementPage {
  rows: BankMovementRow[];
  totalRows: number;
  page: number;
  pageSize: number;
  totals: BankMovementCurrencyTotals[];
  accounts: Array<{ id: string; name: string }>;
  currencies: string[];
  synchronization: BankSynchronizationSummary;
}