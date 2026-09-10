import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { noIndexMetadata } from "@/lib/seo";
import { AccountNavigation } from "@/modules/account/components/account-navigation";
import { readAccountSessionToken } from "@/modules/account/session";
import { SecuritySessionHeading } from "@/modules/account/security/components/security-session-heading";
import { SecuritySessionList } from "@/modules/account/security/components/security-session-list";
import {
  getAccountSecurityLoginPath,
  parseAccountSecurityCallbackState,
} from "@/modules/account/security/schema";
import { listActiveAccountSessions } from "@/modules/account/security/service";
import { parseLoginLocale } from "@/modules/login/schema";

interface AccountSecurityPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({
  params,
}: AccountSecurityPageProps): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({
    locale,
    namespace: "Account.security.metadata",
  });

  return noIndexMetadata({ title: t("title"), description: t("description") });
}

export default async function AccountSecurityPage({
  params,
  searchParams,
}: AccountSecurityPageProps) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);
  const cookieStore = await cookies();
  const sessionToken = readAccountSessionToken(cookieStore.toString());

  if (!sessionToken) redirect(getAccountSecurityLoginPath(locale));

  const sessions = await listActiveAccountSessions({ sessionToken });
  if (!sessions) redirect(getAccountSecurityLoginPath(locale));

  const t = await getTranslations({ locale, namespace: "Account" });
  const query = await searchParams;
  const callbackState = parseAccountSecurityCallbackState(query.state);
  const recovered = query.state === "recovered";
  const pageState = callbackState ?? (recovered ? "recovered" : null);
  const callbackNotice =
    callbackState === "reauthenticated"
      ? t("security.success.reauthenticated")
      : callbackState === "invalid_link"
        ? t("security.errors.invalidLink")
        : callbackState === "session_conflict"
          ? t("security.errors.sessionConflict")
          : recovered
            ? t("security.recovery.recovered")
            : null;
  const positiveNotice =
    callbackState === "reauthenticated" || pageState === "recovered";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <section className="grid min-w-0 gap-6 md:grid-cols-[minmax(11rem,13rem)_minmax(0,1fr)] md:items-start md:gap-8">
        <AccountNavigation
          active="security"
          messages={{
            ariaLabel: t("navigation.profileAriaLabel"),
            profile: t("navigation.profile"),
            dataAndPrivacy: t("navigation.dataAndPrivacy"),
            security: t("navigation.security"),
          }}
        />

        <div className="flex min-w-0 flex-col gap-8">
          <header className="flex min-w-0 flex-col gap-2">
            <h1 className="text-2xl font-semibold text-foreground">
              {t("security.heading.title")}
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t("security.heading.description")}
            </p>
          </header>

          {callbackNotice ? (
            <Alert
              variant={positiveNotice ? "default" : "destructive"}
              role={positiveNotice ? "status" : "alert"}
              aria-live={positiveNotice ? "polite" : "assertive"}
              aria-atomic="true"
            >
              <AlertDescription>{callbackNotice}</AlertDescription>
            </Alert>
          ) : null}

          <section aria-labelledby="active-sessions-heading" className="min-w-0">
            <div className="mb-5 flex min-w-0 flex-col gap-2">
              <SecuritySessionHeading focus={recovered}>
                {t("security.list.title")}
              </SecuritySessionHeading>
              <p
                id="active-sessions-description"
                className="max-w-2xl text-sm text-muted-foreground"
              >
                {t("security.list.description")}
              </p>
            </div>

            <SecuritySessionList
              key={pageState ?? "ready"}
              locale={locale}
              sessions={sessions}
              descriptionId="active-sessions-description"
              messages={{
                ariaLabel: t("security.list.ariaLabel"),
                sessionLabel: t.raw("security.list.sessionLabel") as string,
                current: t("security.list.current"),
                currentOnly: t("security.list.currentOnly"),
                startedAt: t.raw("security.timestamps.startedAt") as string,
                expiresAt: t.raw("security.timestamps.expiresAt") as string,
                unavailable: t("security.timestamps.unavailable"),
                signOut: t("security.actions.signOut"),
                revokeSession: t("security.actions.revokeSession"),
                revokeOtherSessions: t(
                  "security.actions.revokeOtherSessions",
                ),
                dialog: {
                  closeLabel: t("security.dialog.closeLabel"),
                  cancel: t("security.dialog.cancel"),
                  close: t("security.dialog.close"),
                  title: t.raw("security.dialog.individual.title") as string,
                  description: t("security.dialog.individual.description"),
                  endSelected: t("security.dialog.individual.endSelected"),
                  nextRequest: t("security.dialog.individual.nextRequest"),
                  keepOthers: t("security.dialog.individual.keepOthers"),
                  confirm: t("security.dialog.individual.confirm"),
                  startedAt: t.raw("security.timestamps.startedAt") as string,
                  expiresAt: t.raw("security.timestamps.expiresAt") as string,
                  unavailable: t("security.timestamps.unavailable"),
                  revoking: t("security.pending.revokingSession"),
                  refreshing: t("security.pending.refreshing"),
                  reauthenticationTitle: t("security.reauthentication.title"),
                  reauthenticationDescription: t(
                    "security.reauthentication.description",
                  ),
                  sendLink: t("security.reauthentication.sendLink"),
                  sent: t("security.reauthentication.sent"),
                  sendingLink: t("security.pending.sendingLink"),
                  recovering: t("security.recovery.recovering"),
                  sendFailed: t("security.errors.sendFailed"),
                  rateLimited: t("security.errors.rateLimited"),
                  revocationFailed: t("security.errors.revocationFailed"),
                  refreshFailed: t("security.errors.refreshFailed"),
                  bulk: {
                    title: t("security.dialog.bulk.title"),
                    description: t("security.dialog.bulk.description"),
                    endOthers: t("security.dialog.bulk.endOthers"),
                    includeNew: t("security.dialog.bulk.includeNew"),
                    keepCurrent: t("security.dialog.bulk.keepCurrent"),
                    confirm: t("security.dialog.bulk.confirm"),
                  },
                  revokingOtherSessions: t(
                    "security.pending.revokingOtherSessions",
                  ),
                },
              }}
            />
          </section>
        </div>
      </section>
    </main>
  );
}