"use client";

import { useRef, useTransition } from "react";
import { useTranslations } from "next-intl";

import { usePathname, useRouter } from "@/i18n/navigation";

/** Long enough to not navigate on every keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

export function QueueFilters({
  states,
  search,
  state,
}: {
  /** Plain strings: a client module must not reach into the Prisma enums. */
  states: readonly string[];
  search: string;
  state: string | undefined;
}) {
  const t = useTranslations("Bookings");
  const router = useRouter();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPending, startTransition] = useTransition();

  function apply(changes: Record<string, string>) {
    // Read from the live URL rather than from props: a debounced keystroke can
    // land after another filter already navigated, and props would be stale.
    const params = new URLSearchParams(window.location.search);

    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    // A direction is meaningless without the column it belongs to.
    if (!params.get("sort")) params.delete("dir");

    startTransition(() => {
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  }

  return (
    <form
      method="get"
      aria-busy={isPending}
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="q" className="text-sm font-medium">
          {t("queue.searchLabel")}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={search}
          onChange={(event) => {
            const { value } = event.target;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => apply({ q: value.trim() }), SEARCH_DEBOUNCE_MS);
          }}
          className="rounded-md border border-zinc-300 p-2 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="state" className="text-sm font-medium">
          {t("queue.stateLabel")}
        </label>
        <select
          id="state"
          name="state"
          defaultValue={state ?? ""}
          onChange={(event) => apply({ state: event.target.value })}
          className="rounded-md border border-zinc-300 p-2 text-sm"
        >
          <option value="">{t("queue.allStates")}</option>
          {states.map((option) => (
            <option key={option} value={option}>
              {t(`states.${option}`)}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
}
