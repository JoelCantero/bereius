import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Link } from "@/i18n/navigation";
import { noIndexMetadata } from "@/lib/seo";
import {
  BankingAuthorizationError,
  requireBankingActor,
} from "@/modules/banking/authorization";
import {
  confirmReconciliationProposalAction,
  dismissReconciliationProposalAction,
} from "@/modules/banking/actions/reconciliation";
import { requestBankSyncAction } from "@/modules/banking/actions/synchronization";
import { MovementFilters } from "@/modules/banking/components/movement-filters";
import {
  formatMinorUnits,
  MovementTable,
} from "@/modules/banking/components/movement-table";
import { SynchronizationControl } from "@/modules/banking/components/synchronization-control";
import { bankMovementFiltersSchema } from "@/modules/banking/schema";
import {
  BankMovementQueryError,
  queryBankMovements,
  type BankMovementFilters,
} from "@/modules/banking/services/queries";
import { getLoginPathForLocale, parseLoginLocale } from "@/modules/login/schema";

interface BankMovementsPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(
  props: BankMovementsPageProps,
): Promise<Metadata> {
  const locale = parseLoginLocale((await props.params).locale);
  const t = await getTranslations({ locale, namespace: "BankMovements" });
  return noIndexMetadata({ title: t("title"), description: t("description") });
}

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value : value;
}

function filtersQuery(filters: BankMovementFilters, page: number) {
  const params = new URLSearchParams();
  if (filters.direction !== "all") params.set("direction", filters.direction);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.account) params.set("account", filters.account);
  if (filters.currency) params.set("currency", filters.currency);
  if (filters.q) params.set("q", filters.q);
  params.set("page", String(page));
  return `?${params.toString()}`;
}

function InvalidFilters({
  title,
  description,
  message,
  clear,
}: {
  title: string;
  description: string;
  message: string;
  clear: string;
}) {
  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>
      <Alert variant="destructive" tabIndex={-1} autoFocus>
        <AlertDescription>
          {message} <Link href="/bank-movements">{clear}</Link>
        </AlertDescription>
      </Alert>
    </main>
  );
}

export default async function BankMovementsPage({
  params,
  searchParams,
}: BankMovementsPageProps) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);

  try {
    await requireBankingActor();
  } catch (error) {
    if (error instanceof BankingAuthorizationError) {
      if (error.code === "forbidden") redirect("/bookings");
      redirect(
        `${getLoginPathForLocale(locale)}?callbackUrl=${encodeURIComponent("/bank-movements")}`,
      );
    }
    throw error;
  }

  const t = await getTranslations({ locale, namespace: "BankMovements" });
  const raw = await searchParams;
  const parsed = bankMovementFiltersSchema.safeParse({
    direction: scalar(raw.direction),
    from: scalar(raw.from),
    to: scalar(raw.to),
    account: scalar(raw.account),
    currency: scalar(raw.currency),
    q: scalar(raw.q),
    page: scalar(raw.page),
  });
  if (!parsed.success) {
    return (
      <InvalidFilters
        title={t("title")}
        description={t("description")}
        message={t("invalidFilters")}
        clear={t("clearFilters")}
      />
    );
  }

  let projection;
  try {
    projection = await queryBankMovements(parsed.data);
  } catch (error) {
    if (error instanceof BankMovementQueryError) {
      return (
        <InvalidFilters
          title={t("title")}
          description={t("description")}
          message={t("invalidFilters")}
          clear={t("clearFilters")}
        />
      );
    }
    throw error;
  }

  const pageCount = Math.max(
    1,
    Math.ceil(projection.totalRows / projection.pageSize),
  );
  const hasActiveFilters =
    parsed.data.direction !== "all" ||
    Boolean(
      parsed.data.from ||
        parsed.data.to ||
        parsed.data.account ||
        parsed.data.currency ||
        parsed.data.q,
    );

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <SynchronizationControl
        synchronization={projection.synchronization}
        locale={locale}
        action={requestBankSyncAction}
      />

      <MovementFilters
        filters={parsed.data}
        accounts={projection.accounts}
        currencies={projection.currencies}
      />

      {projection.totals.length > 0 ? (
        <section aria-labelledby="movement-totals-heading" className="flex flex-col gap-2">
          <h2 id="movement-totals-heading" className="text-sm font-medium">
            {t("totals.title")}
          </h2>
          <div className="divide-y border-y">
            {projection.totals.map((totals) => (
              <dl
                key={totals.currency}
                className="grid grid-cols-[minmax(4rem,0.5fr)_1fr_1fr] gap-4 py-3 text-sm"
              >
                <div>
                  <dt className="sr-only">{t("filters.currency")}</dt>
                  <dd className="font-medium">{totals.currency}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("totals.income")}
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {formatMinorUnits(
                      totals.incomeMinor,
                      totals.currency,
                      locale,
                      "never",
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("totals.expense")}
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {formatMinorUnits(
                      totals.expenseMinor,
                      totals.currency,
                      locale,
                      "never",
                    )}
                  </dd>
                </div>
              </dl>
            ))}
          </div>
        </section>
      ) : null}

      {projection.rows.length > 0 ? (
        <MovementTable
          rows={projection.rows}
          locale={locale}
          confirmAction={confirmReconciliationProposalAction}
          dismissAction={dismissReconciliationProposalAction}
        />
      ) : (
        <div className="flex items-center justify-between gap-4 border-y py-8">
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
          {hasActiveFilters ? (
            <Link
              href="/bank-movements"
              className="text-sm font-medium underline underline-offset-4"
            >
              {t("clearFilters")}
            </Link>
          ) : null}
        </div>
      )}

      {projection.totalRows > projection.pageSize ? (
        <nav
          aria-label={t("pagination.summary", {
            page: projection.page,
            pages: pageCount,
          })}
          className="flex items-center justify-between gap-4"
        >
          {projection.page > 1 ? (
            <Link
              href={filtersQuery(parsed.data, projection.page - 1)}
              className="text-sm font-medium underline underline-offset-4"
            >
              {t("pagination.previous")}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">
            {t("pagination.summary", {
              page: projection.page,
              pages: pageCount,
            })}
          </span>
          {projection.page < pageCount ? (
            <Link
              href={filtersQuery(parsed.data, projection.page + 1)}
              className="text-sm font-medium underline underline-offset-4"
            >
              {t("pagination.next")}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}