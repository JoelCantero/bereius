"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { IntakeActionState } from "@/modules/booking/actions/intake";

const IDLE: IntakeActionState = { status: "idle" };

type IntakeAction = () => Promise<IntakeActionState>;

function Feedback({ state }: { state: IntakeActionState }) {
  const t = useTranslations("Bookings.queue");
  const errors = useTranslations("Bookings.errors");

  if (state.status === "idle") return null;
  if (state.status === "error") {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {errors(state.reason)}
      </p>
    );
  }

  return (
    <p role="status" className="text-sm text-green-700 dark:text-green-400">
      {t("refreshResult", {
        created: state.created,
        skipped: state.skipped,
        rejected: state.rejected,
      })}
    </p>
  );
}

export function QueueRefresh({ action }: { action: IntakeAction }) {
  const t = useTranslations("Bookings.queue");
  const router = useRouter();
  const [state, formAction, pending] = useActionState<IntakeActionState, FormData>(
    async () => {
      const result = await action();
      if (result.status === "done") router.refresh();
      return result;
    },
    IDLE,
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-2 sm:items-end">
      <Button type="submit" variant="outline" disabled={pending} aria-busy={pending}>
        <RefreshCw
          data-icon="inline-start"
          className={pending ? "animate-spin" : undefined}
          aria-hidden="true"
        />
        {pending ? t("refreshing") : t("refresh")}
      </Button>
      <Feedback state={state} />
    </form>
  );
}