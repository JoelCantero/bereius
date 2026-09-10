"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import type { DecisionActionState } from "@/modules/booking/actions/decisions";

type DecisionAction = (
  previous: DecisionActionState,
  formData: FormData,
) => Promise<DecisionActionState>;

const IDLE: DecisionActionState = { status: "idle" };

function ErrorMessage({ state }: { state: DecisionActionState }) {
  const t = useTranslations("Bookings.errors");

  if (state.status !== "error") return null;

  return (
    <p role="alert" className="text-sm text-red-700">
      {t(state.reason)}
    </p>
  );
}

export function DecisionForm({
  action,
  bookingRequestId,
  expectedFrom,
  label,
  requiresReason = false,
  variant = "primary",
}: {
  action: DecisionAction;
  bookingRequestId: string;
  expectedFrom?: "IN_REVIEW";
  label: string;
  requiresReason?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
  const t = useTranslations("Bookings.actions");
  const [state, formAction, pending] = useActionState(action, IDLE);
  const reasonId = `reason-${bookingRequestId}-${label}`;

  const className =
    variant === "danger"
      ? "rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      : variant === "secondary"
        ? "rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-60"
        : "rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60";

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
      {expectedFrom ? (
        <input type="hidden" name="expectedFrom" value={expectedFrom} />
      ) : null}

      {requiresReason ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className="text-sm font-medium">
            {t("reasonLabel")}
          </label>
          <textarea
            id={reasonId}
            name="reason"
            required
            rows={3}
            aria-describedby={`${reasonId}-hint`}
            className="rounded-md border border-zinc-300 p-2 text-sm"
          />
          <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">
            {t("reasonHint")}
          </p>
        </div>
      ) : null}

      <ErrorMessage state={state} />

      <button type="submit" disabled={pending} className={className}>
        {label}
      </button>
    </form>
  );
}

export function PaymentForm({
  action,
  bookingRequestId,
}: {
  action: DecisionAction;
  bookingRequestId: string;
}) {
  const t = useTranslations("Bookings.actions");
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="bookingRequestId" value={bookingRequestId} />

      <div className="flex flex-col gap-1">
        <label htmlFor="amount" className="text-sm font-medium">
          {t("amountLabel")}
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          step="0.01"
          min="0"
          required
          className="rounded-md border border-zinc-300 p-2 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="receivedAt" className="text-sm font-medium">
          {t("receivedAtLabel")}
        </label>
        <input
          id="receivedAt"
          name="receivedAt"
          type="date"
          required
          className="rounded-md border border-zinc-300 p-2 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="reference" className="text-sm font-medium">
          {t("referenceLabel")}
        </label>
        <input
          id="reference"
          name="reference"
          type="text"
          className="rounded-md border border-zinc-300 p-2 text-sm"
        />
      </div>

      <ErrorMessage state={state} />

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {t("recordPayment")}
      </button>
    </form>
  );
}
