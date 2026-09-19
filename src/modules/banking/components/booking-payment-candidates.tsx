"use client";

import { useActionState } from "react";
import { Check, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import type {
  BookingPaymentCandidate,
  ReconciliationActionState,
} from "@/modules/banking/types";

interface BookingPaymentCandidatesProps {
  bookingRequestId: string;
  candidates: BookingPaymentCandidate[];
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

function CandidateActions({
  bookingRequestId,
  candidate,
  confirmAction,
  dismissAction,
}: Omit<BookingPaymentCandidatesProps, "candidates"> & {
  candidate: BookingPaymentCandidate;
}) {
  const t = useTranslations("Bookings.bankCandidates");
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
      ? t("confirmed")
      : result?.status === "dismissed"
        ? t("dismissed")
        : result?.status === "error"
          ? t(`errors.${result.reason}`)
          : null;

  return (
    <div className="flex min-w-36 flex-col items-end gap-2">
      <div className="flex gap-2">
        <form action={confirmFormAction}>
          <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
          <input type="hidden" name="movementId" value={candidate.movementId} />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <Check className="size-4" aria-hidden="true" />
            {t("link")}
          </button>
        </form>
        <form action={dismissFormAction}>
          <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
          <input type="hidden" name="movementId" value={candidate.movementId} />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            <X className="size-4" aria-hidden="true" />
            {t("dismiss")}
          </button>
        </form>
      </div>
      {resultMessage ? (
        <p
          role={result?.status === "error" ? "alert" : "status"}
          aria-live={result?.status === "error" ? "assertive" : "polite"}
          className={
            result?.status === "error"
              ? "text-xs text-red-700 dark:text-red-400"
              : "text-xs text-green-700 dark:text-green-400"
          }
        >
          {resultMessage}
        </p>
      ) : null}
    </div>
  );
}

export function BookingPaymentCandidates({
  bookingRequestId,
  candidates,
  confirmAction,
  dismissAction,
}: BookingPaymentCandidatesProps) {
  const locale = useLocale();
  const t = useTranslations("Bookings.bankCandidates");
  const money = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
  });
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });

  return (
    <section aria-labelledby="bank-candidates-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="bank-candidates-heading" className="text-lg font-medium">
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("range")}</p>
      </div>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto border-y">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">{t("date")}</th>
                <th scope="col" className="py-2 pr-4 font-medium">{t("concept")}</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">{t("amount")}</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">{t("expected")}</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">{t("difference")}</th>
                <th scope="col" className="py-2 pr-4 font-medium">{t("reference")}</th>
                <th scope="col" className="py-2 text-right font-medium">{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => {
                const amount = Number(candidate.amountMinor) / 100;
                const expected = Number(candidate.expectedAmountMinor) / 100;
                const difference = amount - expected;
                return (
                  <tr key={candidate.movementId} className="border-t align-top">
                    <td className="whitespace-nowrap py-3 pr-4">
                      {date.format(new Date(`${candidate.bookingDate}T00:00:00.000Z`))}
                    </td>
                    <td className="max-w-72 py-3 pr-4">
                      {candidate.narrative ?? t("noConcept")}
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 text-right font-medium tabular-nums">
                      {money.format(amount)}
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 text-right tabular-nums">
                      {money.format(expected)}
                    </td>
                    <td className="whitespace-nowrap py-3 pr-4 text-right tabular-nums text-muted-foreground">
                      {difference === 0
                        ? t("exact")
                        : money.format(difference)}
                    </td>
                    <td className="py-3 pr-4 text-xs text-muted-foreground">
                      {candidate.estimateReferenceFound
                        ? t("referenceFound")
                        : t("referenceMissing")}
                    </td>
                    <td className="py-3 text-right">
                      <CandidateActions
                        bookingRequestId={bookingRequestId}
                        candidate={candidate}
                        confirmAction={confirmAction}
                        dismissAction={dismissAction}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}