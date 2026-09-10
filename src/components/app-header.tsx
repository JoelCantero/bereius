import { getTranslations } from "next-intl/server";
import { getServerSession } from "next-auth";

import { AppNavigation } from "@/components/app-navigation";
import { Link } from "@/i18n/navigation";
import { authOptions } from "@/lib/auth";
import { parseLoginLocale } from "@/modules/login/schema";

interface AppHeaderProps {
  locale: string;
  projectName: string;
}

export async function AppHeader({ locale: localeInput, projectName }: AppHeaderProps) {
  const locale = parseLoginLocale(localeInput);
  const t = await getTranslations({ locale, namespace: "HomePage.navigation" });
  const session = await getServerSession(authOptions);

  return (
    <header className="border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950 sm:px-6">
      <a
        href="#main-content"
        className="sr-only fixed top-3 left-3 z-50 rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-md focus:not-sr-only focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {t("skipToContent")}
      </a>
      <div className="flex h-16 w-full items-center justify-between gap-2">
        <Link
          href="/"
          className="shrink-0 text-sm font-semibold text-zinc-950 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 dark:text-zinc-50"
        >
          {projectName}
        </Link>
        <AppNavigation
          authenticated={Boolean(session?.user)}
          locale={locale}
          labels={{
            ariaLabel: t("ariaLabel"),
            login: t("login"),
            signup: t("signup"),
            toggleTheme: t("toggleTheme"),
            language: t("language"),
          }}
        />
      </div>
    </header>
  );
}