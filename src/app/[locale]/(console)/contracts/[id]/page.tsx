import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Link } from "@/i18n/navigation";
import { holdedEstimateUrl } from "@/lib/holded/links";
import { noIndexMetadata } from "@/lib/seo";
import { linkEstimateAction } from "@/modules/booking/actions/contact";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { ContactSyncButton } from "@/modules/booking/components/contact-sync";
import { BookingStateBadge } from "@/modules/booking/components/state-badge";
import { readContract } from "@/modules/booking/services/contracts";
import { getLoginPathForLocale, parseLoginLocale } from "@/modules/login/schema";

interface ContractDetailPageProps {
  params: Promise<{ locale: string; id: string }>;
}

const KNOWN_STATUSES = ["pending", "completed", "partial"];

export async function generateMetadata({
  params,
}: ContractDetailPageProps): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Contracts" });

  return noIndexMetadata({ title: t("title"), description: t("description") });
}

export default async function ContractDetailPage({ params }: ContractDetailPageProps) {
  const { locale: rawLocale, id } = await params;
  const locale = parseLoginLocale(rawLocale);
  setRequestLocale(locale);

  try {
    await requireBookingActor();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      redirect(
        `${getLoginPathForLocale(locale)}?callbackUrl=${encodeURIComponent(`/contracts/${id}`)}`,
      );
    }
    throw error;
  }

  const t = await getTranslations({ locale, namespace: "Contracts" });
  const bookings = await getTranslations({ locale, namespace: "Bookings" });
  const detail = await readContract(id);

  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });

  const back = (
    <Link href="/contracts" className="text-sm underline">
      {t("detail.back")}
    </Link>
  );

  if (detail.status !== "linked" && detail.status !== "unlinked") {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
        {back}
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-zinc-600">
          {detail.status === "no_key"
            ? t("noKey")
            : detail.status === "missing"
              ? t("missing")
              : t("unavailable")}
        </p>
      </main>
    );
  }

  const { contract } = detail;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div className="flex flex-col items-start gap-2">
        {back}
        <h1 className="text-2xl font-semibold">
          <a
            href={holdedEstimateUrl(contract.id)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 hover:underline focus-visible:underline"
          >
            {contract.number ?? contract.id}
            <ExternalLink className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">{t("detail.openInHolded")}</span>
          </a>
        </h1>
        {detail.status === "linked" ? (
          <BookingStateBadge
            state={detail.link.state}
            label={bookings(`states.${detail.link.state}`)}
          />
        ) : (
          <Badge variant="outline">{t("unlinked")}</Badge>
        )}
      </div>

      <section aria-labelledby="summary-heading" className="flex flex-col gap-1">
        <h2 id="summary-heading" className="text-lg font-medium">
          {t("detail.summary")}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-600">{t("columns.date")}</dt>
          <dd>{contract.date ? dateFormat.format(new Date(contract.date)) : "—"}</dd>
          <dt className="text-zinc-600">{t("columns.total")}</dt>
          <dd className="tabular-nums">
            {contract.totalCents === null ? "—" : money.format(contract.totalCents / 100)}
          </dd>
          <dt className="text-zinc-600">{t("columns.status")}</dt>
          <dd>
            {contract.status === null
              ? "—"
              : KNOWN_STATUSES.includes(contract.status)
                ? t(`statuses.${contract.status}`)
                : contract.status}
          </dd>
          {contract.description ? (
            <>
              <dt className="text-zinc-600">{t("detail.summary")}</dt>
              <dd>{contract.description}</dd>
            </>
          ) : null}
          <dt className="text-zinc-600">{t("detail.contact")}</dt>
          <dd>
            {contract.contactName ?? "—"}
            {detail.status === "unlinked" && detail.taxId ? (
              <span className="block text-xs text-zinc-600">{detail.taxId}</span>
            ) : null}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="link-heading" className="flex flex-col gap-3">
        <h2 id="link-heading" className="text-lg font-medium">
          {detail.status === "linked" ? t("columns.link") : t("detail.candidates")}
        </h2>

        {detail.status === "linked" ? (
          <>
            <p className="text-sm">
              {t("detail.linkedTo", { name: detail.link.customerName })}
            </p>
            <Link
              href={`/bookings/${detail.link.bookingRequestId}`}
              className="self-start text-sm underline"
            >
              {t("detail.open")}
            </Link>
          </>
        ) : detail.taxId === null ? (
          <p className="text-sm text-zinc-600">{t("detail.noTaxId")}</p>
        ) : detail.candidates.length === 0 ? (
          <p className="text-sm text-zinc-600">{t("detail.noCandidates")}</p>
        ) : (
          <>
            <p className="text-sm text-zinc-600">{t("detail.candidatesHint")}</p>
            <p className="text-sm text-zinc-600">{t("detail.approvalNote")}</p>
            <ul className="flex flex-col gap-2 text-sm">
              {detail.candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 p-2"
                >
                  <span>
                    {/* Every candidate is the same customer, so the stay is what
                        tells them apart. */}
                    <span className="font-medium">
                      {t("detail.stay", {
                        start: dateFormat.format(candidate.startDate),
                        end: dateFormat.format(candidate.endDate),
                        headcount: candidate.headcount,
                      })}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <BookingStateBadge
                        state={candidate.state}
                        label={bookings(`states.${candidate.state}`)}
                      />
                      {candidate.suggested ? (
                        <Badge className="bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200">
                          {t("detail.suggested")}
                        </Badge>
                      ) : null}
                    </span>
                  </span>
                  <ContactSyncButton
                    action={linkEstimateAction}
                    bookingRequestId={candidate.id}
                    holdedId={contract.id}
                    label={t("detail.link")}
                    variant="secondary"
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
