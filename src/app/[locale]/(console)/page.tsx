import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import type { ConsoleSection } from "@/components/console-sections";
import { Link } from "@/i18n/navigation";
import { parseLoginLocale } from "@/modules/login/schema";
import { getEnv } from "@/lib/env";
import { publicPageMetadata } from "@/lib/seo";
import { buildConsoleNavigation } from "@/modules/console/navigation";

type HomePageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: HomePageProps): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Metadata" });
  const { BRAND } = getEnv();
  return publicPageMetadata({
    origin: BRAND.canonicalOrigin,
    siteName: BRAND.productName,
    locale,
    pathname: "/",
    title: t("title"),
    description: t("description"),
  });
}

export default async function Home({ params }: HomePageProps) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);
  const navigation = await buildConsoleNavigation(locale);

  if (!navigation) {
    const t = await getTranslations("HomePage");

    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-24">
        <h1 className="text-4xl font-semibold tracking-tight text-black dark:text-zinc-50">
          {t("title")}
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          {t("tagline")}
        </p>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">{t("getStarted")}</p>
      </main>
    );
  }

  const t = await getTranslations("Console");
  const cards: ConsoleSection[] = [
    ...navigation.sections,
    { key: "account", label: t("sections.account"), links: navigation.userLinks },
  ];

  return (
    <main className="flex w-full flex-1 flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          {t("title")}
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">{t("subtitle")}</p>
      </div>

      {cards.map((section) => (
        <section key={section.key} aria-labelledby={`section-${section.key}`}>
          <h2
            id={`section-${section.key}`}
            className="mb-3 text-sm font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400"
          >
            {section.label}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {section.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="flex h-full flex-col gap-1 rounded-lg border border-zinc-200 bg-white p-4 outline-none transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  <span className="font-medium text-zinc-950 dark:text-zinc-50">
                    {link.label}
                  </span>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    {link.description}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
