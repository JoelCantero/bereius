"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import type { TreasuryAccountSettingsActionState } from "@/modules/banking/types";

export interface TreasuryAccountOptionView {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
}

export interface TreasuryAccountSettingsView {
  holdedAccountId: string;
  importStartDate: string;
  importStartDateLocked: boolean;
}

export interface TreasuryAccountSettingsProps {
  status: "ok" | "not_configured" | "unauthorized" | "unavailable";
  options: TreasuryAccountOptionView[];
  current: TreasuryAccountSettingsView | null;
  defaultImportStartDate: string;
  action: (
    previous: TreasuryAccountSettingsActionState,
    formData: FormData,
  ) => Promise<TreasuryAccountSettingsActionState>;
}

const IDLE: TreasuryAccountSettingsActionState = { status: "idle" };

export function TreasuryAccountSettings({
  status,
  options,
  current,
  defaultImportStartDate,
  action,
}: TreasuryAccountSettingsProps) {
  const t = useTranslations("Bookings.settings.treasury");
  const [state, formAction, pending] = useActionState(action, IDLE);
  const eligible = options.filter(
    (option) => !option.archived && option.currency === "EUR",
  );
  const accountUnavailable = status !== "ok" || eligible.length === 0;
  const importStartDate = current?.importStartDate ?? defaultImportStartDate;
  const dateLocked = current?.importStartDateLocked ?? false;

  return (
    <section aria-labelledby="treasury-account-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="treasury-account-heading" className="text-lg font-medium">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {status !== "ok" ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {t(`availability.${status}`)}
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="holdedAccountId" className="text-sm font-medium">
            {t("account")}
          </label>
          <select
            id="holdedAccountId"
            name={accountUnavailable ? undefined : "holdedAccountId"}
            defaultValue={current?.holdedAccountId ?? ""}
            required={!accountUnavailable}
            disabled={accountUnavailable}
            className="rounded-md border border-zinc-300 p-2 text-sm disabled:bg-zinc-100 disabled:text-zinc-500"
          >
            <option value="">{t(accountUnavailable ? "accountUnavailable" : "choose")}</option>
            {eligible.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          {accountUnavailable && current ? (
            <input type="hidden" name="holdedAccountId" value={current.holdedAccountId} />
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="importStartDate" className="text-sm font-medium">
            {t("importStartDate")}
          </label>
          <input
            id="importStartDate"
            name={dateLocked ? undefined : "importStartDate"}
            type="date"
            required
            disabled={dateLocked}
            defaultValue={importStartDate}
            aria-describedby="import-start-date-hint"
            className="rounded-md border border-zinc-300 p-2 text-sm disabled:bg-zinc-100 disabled:text-zinc-500"
          />
          {dateLocked ? (
            <input type="hidden" name="importStartDate" value={importStartDate} />
          ) : null}
          <p id="import-start-date-hint" className="text-xs text-muted-foreground">
            {t(dateLocked ? "importStartDateLocked" : "importStartDateHint")}
          </p>
        </div>

        {state.status === "error" ? (
          <p role="alert" className="text-sm text-red-700">
            {t(`errors.${state.reason}`)}
          </p>
        ) : state.status === "saved" ? (
          <p role="status" className="text-sm text-green-700 dark:text-green-400">
            {t("saved")}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending || accountUnavailable}
          className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t(pending ? "saving" : "save")}
        </button>
      </form>
    </section>
  );
}