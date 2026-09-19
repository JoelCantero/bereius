"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type {
  ReconciliationActionState,
  ReconciliationProposalSummary,
} from "@/modules/banking/types";

export interface ReconciliationActionsProps {
  proposal: ReconciliationProposalSummary;
  confirmAction: (
    previous: ReconciliationActionState,
    formData: FormData,
  ) => Promise<ReconciliationActionState>;
  dismissAction: (
    previous: ReconciliationActionState,
    formData: FormData,
  ) => Promise<ReconciliationActionState>;
}

const IDLE: ReconciliationActionState = { status: "idle" };

export function ReconciliationActions({
  proposal,
  confirmAction,
  dismissAction,
}: ReconciliationActionsProps) {
  const t = useTranslations("BankMovements");
  const [confirmState, confirmFormAction, confirmPending] = useActionState(
    confirmAction,
    IDLE,
  );
  const [dismissState, dismissFormAction, dismissPending] = useActionState(
    dismissAction,
    IDLE,
  );
  const pending = confirmPending || dismissPending;
  const result =
    confirmState.status !== "idle"
      ? confirmState
      : dismissState.status !== "idle"
        ? dismissState
        : null;
  const resultMessage =
    result?.status === "confirmed"
      ? t("proposals.confirmedAnnouncement")
      : result?.status === "dismissed"
        ? t("proposals.dismissedAnnouncement")
        : result?.status === "error"
          ? t(`proposals.errors.${result.reason}`)
          : null;

  return (
    <section
      aria-labelledby={`proposal-${proposal.id}-title`}
      className="flex flex-col gap-2 border-l-2 border-zinc-300 pl-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p id={`proposal-${proposal.id}-title`} className="text-sm font-medium">
          {t("proposals.title")}
        </p>
        <Badge variant={proposal.status === "pending" ? "secondary" : "outline"}>
          {t(`proposals.${proposal.status}`)}
        </Badge>
      </div>
      <p className="text-sm">{t("proposals.estimate", { number: proposal.estimateNumber })}</p>
      {proposal.decidedByDisplay ? (
        <p className="text-xs text-muted-foreground">
          {t("proposals.decidedBy", { name: proposal.decidedByDisplay })}
        </p>
      ) : null}

      {proposal.status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <form action={confirmFormAction}>
            <input type="hidden" name="proposalId" value={proposal.id} />
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {t("proposals.confirm")}
            </button>
          </form>
          <form action={dismissFormAction}>
            <input type="hidden" name="proposalId" value={proposal.id} />
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium disabled:opacity-60"
            >
              {t("proposals.dismiss")}
            </button>
          </form>
        </div>
      ) : null}

      {resultMessage ? (
        <p
          role={result?.status === "error" ? "alert" : "status"}
          aria-live={result?.status === "error" ? "assertive" : "polite"}
          className={
            result?.status === "error"
              ? "text-sm text-red-700"
              : "text-sm text-green-700 dark:text-green-400"
          }
        >
          {resultMessage}
        </p>
      ) : null}
    </section>
  );
}