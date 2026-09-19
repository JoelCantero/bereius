"use client";

import { useEffect, useRef, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { usePathname, useRouter } from "@/i18n/navigation";
import type { BankMovementFilters } from "@/modules/banking/types";

export interface MovementFiltersProps {
  filters: BankMovementFilters;
  accounts: Array<{ id: string; name: string }>;
  currencies: string[];
}

const SEARCH_DEBOUNCE_MS = 300;
const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function MovementFilters({
  filters,
  accounts,
  currencies,
}: MovementFiltersProps) {
  const t = useTranslations("BankMovements");
  const pathname = usePathname();
  const router = useRouter();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  function apply(changes: Record<string, string>) {
    const params = new URLSearchParams(window.location.search);
    for (const [name, value] of Object.entries(changes)) {
      if (value && !(name === "direction" && value === "all")) {
        params.set(name, value);
      } else {
        params.delete(name);
      }
    }
    params.delete("page");

    startTransition(() => {
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  }

  return (
    <form
      method="get"
      aria-busy={pending}
      onSubmit={(event) => event.preventDefault()}
    >
      <FieldGroup className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
        <Field>
          <FieldLabel htmlFor="movement-direction">
            {t("filters.direction")}
          </FieldLabel>
          <select
            id="movement-direction"
            name="direction"
            defaultValue={filters.direction}
            onChange={(event) => apply({ direction: event.target.value })}
            className={SELECT_CLASS}
          >
            <option value="all">{t("filters.all")}</option>
            <option value="income">{t("directions.income")}</option>
            <option value="expense">{t("directions.expense")}</option>
          </select>
        </Field>

        <Field>
          <FieldLabel htmlFor="movement-from">{t("filters.from")}</FieldLabel>
          <Input
            id="movement-from"
            name="from"
            type="date"
            defaultValue={filters.from ?? ""}
            onChange={(event) => apply({ from: event.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="movement-to">{t("filters.to")}</FieldLabel>
          <Input
            id="movement-to"
            name="to"
            type="date"
            defaultValue={filters.to ?? ""}
            onChange={(event) => apply({ to: event.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="movement-account">
            {t("filters.account")}
          </FieldLabel>
          <select
            id="movement-account"
            name="account"
            defaultValue={filters.account ?? ""}
            onChange={(event) => apply({ account: event.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">{t("filters.allAccounts")}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>

        <Field>
          <FieldLabel htmlFor="movement-currency">
            {t("filters.currency")}
          </FieldLabel>
          <select
            id="movement-currency"
            name="currency"
            defaultValue={filters.currency ?? ""}
            onChange={(event) => apply({ currency: event.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">{t("filters.allCurrencies")}</option>
            {currencies.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </Field>

        <Field className="sm:col-span-2 xl:col-span-2">
          <FieldLabel htmlFor="movement-search">
            {t("filters.search")}
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id="movement-search"
              name="q"
              type="search"
              maxLength={100}
              defaultValue={filters.q}
              onChange={(event) => {
                const value = event.target.value;
                if (searchTimer.current) clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(
                  () => apply({ q: value.trim() }),
                  SEARCH_DEBOUNCE_MS,
                );
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (searchTimer.current) clearTimeout(searchTimer.current);
                startTransition(() => router.replace(pathname, { scroll: false }));
              }}
            >
              {t("clearFilters")}
            </Button>
          </div>
        </Field>
      </FieldGroup>
    </form>
  );
}