"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import type { ContactActionState } from "@/modules/booking/actions/contact";

const IDLE: ContactActionState = { status: "idle" };

type ContactAction = (
  previous: ContactActionState,
  formData: FormData,
) => Promise<ContactActionState>;

function Feedback({ state }: { state: ContactActionState }) {
  const errors = useTranslations("Bookings.errors");

  if (state.status !== "error") return null;

  return (
    <p role="alert" className="text-sm text-red-700">
      {errors(state.reason)}
    </p>
  );
}

export function ContactSyncButton({
  action,
  bookingRequestId,
  holdedId,
  label,
  variant = "primary",
}: {
  action: ContactAction;
  bookingRequestId: string;
  holdedId?: string;
  label: string;
  variant?: "primary" | "secondary";
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="bookingRequestId" value={bookingRequestId} />
      {holdedId ? <input type="hidden" name="holdedId" value={holdedId} /> : null}
      <Feedback state={state} />
      <button
        type="submit"
        disabled={pending}
        className={
          variant === "primary"
            ? "self-start rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            : "self-start rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-60"
        }
      >
        {label}
      </button>
    </form>
  );
}
