import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { noIndexMetadata } from "@/lib/seo";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { ContractFilters } from "@/modules/booking/components/contract-filters";
import { BookingStateBadge } from "@/modules/booking/components/state-badge";
import { listContracts, type Contract } from "@/modules/booking/services/contracts";
import { getLoginPathForLocale, parseLoginLocale } from "@/modules/login/schema";

interface ContractsPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; link?: string }>;
}

/** Holded's own vocabulary; anything else is shown verbatim rather than guessed. */
const KNOWN_STATUSES = ["pending", "completed", "partial"];

export async function generateMetadata({ params }: ContractsPageProps): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Contracts" });

  return noIndexMetadata({ title: t("title"), description: t("description") });
}

function matches(contract: Contract, needle: string): boolean {
  return [contract.number, contract.contactName, contract.description]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

export default async function ContractsPage({ params, searchParams }: ContractsPageProps) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);

  try {
    await requireBookingActor();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      redirect(
        `${getLoginPathForLocale(locale)}?callbackUrl=${encodeURIComponent("/contracts")}`,
      );
    }
    throw error;
  }

  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: "Contracts" });
  const bookings = await getTranslations({ locale, namespace: "Bookings" });
  const result = await listContracts();

  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });

  const heading = <h1 className="text-2xl font-semibold">{t("title")}</h1>;

  if (result.status !== "ok") {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
        {heading}
        <p className="text-sm text-zinc-600">
          {result.status === "no_key" ? t("noKey") : t("unavailable")}
        </p>
      </main>
    );
  }

  const needle = query.q?.trim().toLocaleLowerCase() ?? "";
  const link = query.link === "linked" || query.link === "unlinked" ? query.link : undefined;

  const contracts = result.contracts.filter((contract) => {
    if (link === "linked" && !contract.link) return false;
    if (link === "unlinked" && contract.link) return false;
    return needle.length === 0 || matches(contract, needle);
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      {heading}

      <ContractFilters search={query.q ?? ""} link={link} />

      {/* Filtering happens as the operator types, so the count is announced. */}
      <p role="status" className="text-sm text-muted-foreground">
        {t("count", { count: contracts.length })}
      </p>

      {contracts.length === 0 ? (
        <p className="text-sm text-zinc-600">{t("empty")}</p>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableCaption className="sr-only">{t("title")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.number")}</TableHead>
                <TableHead>{t("columns.date")}</TableHead>
                <TableHead>{t("columns.customer")}</TableHead>
                <TableHead className="text-right">{t("columns.total")}</TableHead>
                <TableHead>{t("columns.status")}</TableHead>
                <TableHead>{t("columns.link")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contracts.map((contract) => (
                <TableRow
                  key={contract.id}
                  className="relative cursor-pointer focus-within:bg-muted/50 hover:bg-muted/50"
                >
                  <TableCell>
                    {/* The link covers the row, so a click anywhere opens it while
                        the keyboard still has a single, real target. */}
                    <Link
                      href={`/contracts/${contract.id}`}
                      className="font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                    >
                      {contract.number ?? contract.id}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {contract.date ? dateFormat.format(new Date(contract.date)) : "—"}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {contract.contactName ?? "—"}
                    {contract.description ? (
                      <span className="block text-xs text-muted-foreground">
                        {contract.description}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {contract.totalCents === null
                      ? "—"
                      : money.format(contract.totalCents / 100)}
                  </TableCell>
                  <TableCell>
                    {contract.status === null
                      ? "—"
                      : KNOWN_STATUSES.includes(contract.status)
                        ? t(`statuses.${contract.status}`)
                        : contract.status}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {contract.link ? (
                      <BookingStateBadge
                        state={contract.link.state}
                        label={bookings(`states.${contract.link.state}`)}
                      />
                    ) : (
                      <Badge variant="outline">{t("unlinked")}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
