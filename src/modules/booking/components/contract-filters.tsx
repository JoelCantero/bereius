"use client";

import { useRef, useTransition } from "react";
import { useTranslations } from "next-intl";

import { usePathname, useRouter } from "@/i18n/navigation";

/** Long enough to not navigate on every keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

export function ContractFilters({
  search,
  link,
}: {
  search: string;
  link: string | undefined;
}) {
  const t = useTranslations("Contracts");
  const router = useRouter();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPending, startTransition] = useTransition();

  function apply(changes: Record<string, string>) {
    // Read from the live URL, not from props: a debounced keystroke can land
    // after another filter already navigated.
    const params = new URLSearchParams(window.location.search);

    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }

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
          {t("searchLabel")}
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
        <label htmlFor="link" className="text-sm font-medium">
          {t("linkLabel")}
        </label>
        <select
          id="link"
          name="link"
          defaultValue={link ?? ""}
          onChange={(event) => apply({ link: event.target.value })}
          className="rounded-md border border-zinc-300 p-2 text-sm"
        >
          <option value="">{t("allLinks")}</option>
          <option value="linked">{t("filters.linked")}</option>
          <option value="unlinked">{t("filters.unlinked")}</option>
        </select>
      </div>
    </form>
  );
}
