"use client";

import { RefreshCw, RotateCcw } from "lucide-react";
import { useActionState, useEffect } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useRouter } from "@/i18n/navigation";
import type {
  BankIntegrationState,
  BankSynchronizationSummary,
  BankSyncActionState,
  BankSyncRunSummary,
} from "@/modules/banking/types";
import type { BankSyncIncidentCode } from "@/modules/banking/schema";

export interface SynchronizationControlProps {
  synchronization: BankSynchronizationSummary;
  locale?: "en" | "es" | "ca";
  action: (
    previous: BankSyncActionState,
    formData: FormData,
  ) => Promise<BankSyncActionState>;
}

export const BANK_SYNC_POLL_INTERVAL_MS = 5_000;

const IDLE: BankSyncActionState = { status: "idle" };

const statusMessageKeys = {
  QUEUED: "synchronization.status.queued",
  RUNNING: "synchronization.status.running",
  RETRYING: "synchronization.status.retrying",
  SUCCEEDED: "synchronization.status.succeeded",
  PARTIAL: "synchronization.status.partial",
  FAILED: "synchronization.status.failed",
} as const satisfies Record<BankSyncRunSummary["status"], string>;

const stateMessageKeys = {
  unconfigured: "synchronization.state.unconfigured",
  initial_active: "synchronization.state.initial_active",
  healthy: "synchronization.state.healthy",
  stale: "synchronization.state.stale",
  retrying: "synchronization.state.retrying",
  partial: "synchronization.state.partial",
  failed: "synchronization.state.failed",
} as const satisfies Record<BankIntegrationState, string>;

const incidentMessageKeys = {
  PROVIDER_UNAUTHORIZED: "synchronization.incidents.PROVIDER_UNAUTHORIZED",
  PROVIDER_NOT_FOUND: "synchronization.incidents.PROVIDER_NOT_FOUND",
  PROVIDER_RATE_LIMITED: "synchronization.incidents.PROVIDER_RATE_LIMITED",
  PROVIDER_UNAVAILABLE: "synchronization.incidents.PROVIDER_UNAVAILABLE",
  PROVIDER_REQUEST_REJECTED: "synchronization.incidents.PROVIDER_REQUEST_REJECTED",
  RESPONSE_TOO_LARGE: "synchronization.incidents.RESPONSE_TOO_LARGE",
  MALFORMED_PAGE: "synchronization.incidents.MALFORMED_PAGE",
  MISSING_CURSOR: "synchronization.incidents.MISSING_CURSOR",
  REPEATED_CURSOR: "synchronization.incidents.REPEATED_CURSOR",
  INVALID_MOVEMENT_ID: "synchronization.incidents.INVALID_MOVEMENT_ID",
  ACCOUNT_MISMATCH: "synchronization.incidents.ACCOUNT_MISMATCH",
  INVALID_BOOKING_DATE: "synchronization.incidents.INVALID_BOOKING_DATE",
  INVALID_VALUE_DATE: "synchronization.incidents.INVALID_VALUE_DATE",
  INVALID_AMOUNT: "synchronization.incidents.INVALID_AMOUNT",
  ZERO_AMOUNT: "synchronization.incidents.ZERO_AMOUNT",
  INVALID_CURRENCY: "synchronization.incidents.INVALID_CURRENCY",
  DESCRIPTION_TOO_LONG: "synchronization.incidents.DESCRIPTION_TOO_LONG",
  CONFIRMED_MATCH_CHANGED: "synchronization.incidents.CONFIRMED_MATCH_CHANGED",
} as const satisfies Record<BankSyncIncidentCode, string>;

function isActive(status: BankSyncRunSummary["status"] | undefined) {
  return status === "QUEUED" || status === "RUNNING" || status === "RETRYING";
}

function formatDate(locale: "en" | "es" | "ca", value: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function SynchronizationControl({
  synchronization,
  locale = "en",
  action,
}: SynchronizationControlProps) {
  const t = useTranslations("BankMovements");
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, IDLE);
  const latestRun = synchronization.latestRun;
  const active = isActive(latestRun?.status);
  const requestAccepted =
    state.status === "accepted" || state.status === "already_running";
  const retry = Boolean(latestRun?.retryEligible && !active);
  const degraded = ["stale", "retrying", "partial", "failed"].includes(
    synchronization.integrationState,
  );
  const showCooldown = Boolean(
    synchronization.configured &&
      !synchronization.manualRefreshAllowed &&
      !active &&
      synchronization.manualRefreshAvailableAt,
  );
  const disabled =
    pending ||
    active ||
    requestAccepted ||
    !synchronization.manualRefreshAllowed;

  useEffect(() => {
    if (!active && !requestAccepted) return;
    const interval = window.setInterval(
      () => router.refresh(),
      BANK_SYNC_POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [active, requestAccepted, router]);

  const resultMessage =
    state.status === "accepted"
      ? t("synchronization.accepted")
      : state.status === "already_running"
        ? t("synchronization.alreadyRunning")
        : state.status === "error"
          ? t(`synchronization.errors.${state.reason}`)
          : null;

  return (
    <section
      aria-labelledby="bank-synchronization-heading"
      className="flex flex-col gap-3 border-y border-border py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="bank-synchronization-heading" className="text-base font-medium">
            {t("synchronization.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(stateMessageKeys[synchronization.integrationState])}
          </p>
        </div>
        {latestRun ? (
          <Badge
            aria-live="polite"
            aria-atomic="true"
            variant={
              latestRun.status === "FAILED"
                ? "destructive"
                : latestRun.status === "SUCCEEDED"
                  ? "secondary"
                  : "outline"
            }
          >
            {t(statusMessageKeys[latestRun.status])}
          </Badge>
        ) : null}
      </div>

      {latestRun ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
          <span>{t("synchronization.progress.pages", { count: latestRun.pageCount })}</span>
          <span>{t("synchronization.progress.items", { count: latestRun.itemCount })}</span>
          <span>{t("synchronization.progress.inserted", { count: latestRun.insertedCount })}</span>
          <span>{t("synchronization.progress.updated", { count: latestRun.updatedCount })}</span>
          <span>{t("synchronization.progress.unchanged", { count: latestRun.unchangedCount })}</span>
          <span>{t("synchronization.progress.incidents", { count: latestRun.incidentCount })}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {synchronization.latestSuccessfulAt ? (
          <p>
            {t("synchronization.lastSuccess", {
              date: formatDate(locale, synchronization.latestSuccessfulAt),
            })}
          </p>
        ) : null}
        {latestRun?.finishedAt ? (
          <p>
            {t("synchronization.finishedAt", {
              date: formatDate(locale, latestRun.finishedAt),
            })}
          </p>
        ) : null}
        {latestRun?.nextAttemptAt && latestRun.status === "RETRYING" ? (
          <p>
            {t("synchronization.nextAttempt", {
              date: formatDate(locale, latestRun.nextAttemptAt),
            })}
          </p>
        ) : null}
        <p>
          {t("synchronization.pendingProposals", {
            count: synchronization.pendingProposalCount,
          })}
        </p>
      </div>

      {latestRun?.failureCode || synchronization.incidents.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-amber-800 dark:text-amber-300">
          {latestRun?.failureCode ? (
            <li>{t(incidentMessageKeys[latestRun.failureCode])}</li>
          ) : null}
          {synchronization.incidents.map((incident) => (
            <li key={`${incident.pageNumber}:${incident.itemIndex ?? "page"}:${incident.code}`}>
              {t(
                incident.itemIndex === null
                  ? "synchronization.incidentAtPage"
                  : "synchronization.incidentAtItem",
                {
                  reason: t(incidentMessageKeys[incident.code]),
                  page: incident.pageNumber,
                  item: incident.itemIndex ?? 0,
                },
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {degraded ? (
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>{t("synchronization.retainedData")}</p>
          <p>{t("synchronization.expiryDeferred")}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <form action={formAction}>
          {retry && latestRun ? (
            <input type="hidden" name="retryRunId" value={latestRun.id} />
          ) : null}
          <Button type="submit" disabled={disabled} aria-busy={pending}>
            {retry ? <RotateCcw aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {t(
              pending
                ? "synchronization.refreshing"
                : retry
                  ? "synchronization.retry"
                  : "synchronization.refresh",
            )}
          </Button>
        </form>
        {showCooldown && synchronization.manualRefreshAvailableAt ? (
          <p className="text-xs text-muted-foreground">
            {t("synchronization.cooldown", {
              date: formatDate(locale, synchronization.manualRefreshAvailableAt),
            })}
          </p>
        ) : null}
      </div>

      {resultMessage ? (
        <p
          role={state.status === "error" ? "alert" : "status"}
          aria-live={state.status === "error" ? "assertive" : "polite"}
          className={
            state.status === "error"
              ? "text-sm text-destructive"
              : "text-sm text-green-700 dark:text-green-400"
          }
        >
          {resultMessage}
        </p>
      ) : null}
    </section>
  );
}