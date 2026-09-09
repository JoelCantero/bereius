import { setRequestLocale } from "next-intl/server";

import { ConsoleShell } from "@/components/console-shell";
import { parseLoginLocale } from "@/modules/login/schema";
import { buildConsoleNavigation } from "@/modules/console/navigation";

/**
 * Wraps every signed-in route in the console. Anonymous visitors fall through
 * untouched, because the home page is public and the rest redirect themselves.
 */
export default async function ConsoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);
  const navigation = await buildConsoleNavigation(locale);

  if (!navigation) return children;

  return (
    <ConsoleShell
      sections={navigation.sections}
      user={navigation.user}
      userLinks={navigation.userLinks}
      homeHref={navigation.homeHref}
      labels={navigation.labels}
    >
      {children}
    </ConsoleShell>
  );
}
