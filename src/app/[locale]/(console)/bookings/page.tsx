import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import type { BookingState } from "@/generated/prisma/enums";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { noIndexMetadata } from "@/lib/seo";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { QueueFilters } from "@/modules/booking/components/queue-filters";
import { BookingStateBadge } from "@/modules/booking/components/state-badge";
import {
  BOOKING_QUEUE_SORTS,
  listBookingQueue,
  type BookingQueueDirection,
  type BookingQueueSort,
} from "@/modules/booking/services/queries";
import { getLoginPathForLocale, parseLoginLocale } from "@/modules/login/schema";

interface BookingsPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    state?: string;
    q?: string;
    sort?: string;
    dir?: string;
  }>;
}

const BOOKING_STATES: readonly BookingState[] = [
  "IN_REVIEW",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "INVOICED",
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
];

export async function generateMetadata({ params }: BookingsPageProps): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Bookings.queue" });

  return noIndexMetadata({ title: t("title"), description: t("description") });
}

function isBookingState(value: string | undefined): value is BookingState {
  return value !== undefined && BOOKING_STATES.includes(value as BookingState);
}

function isSort(value: string | undefined): value is BookingQueueSort {
  return value !== undefined && BOOKING_QUEUE_SORTS.includes(value as BookingQueueSort);
}

/** Sorting lives in the URL, so it survives a reload and needs no client state. */
function SortableHead({
  column,
  label,
  sort,
  direction,
  filters,
}: {
  column: BookingQueueSort;
  label: string;
  sort: BookingQueueSort | undefined;
  direction: BookingQueueDirection;
  filters: { q?: string; state?: BookingState };
}) {
  const active = sort === column;
  const params = new URLSearchParams({
    sort: column,
    dir: active && direction === "desc" ? "asc" : "desc",
  });
  if (filters.q) params.set("q", filters.q);
  if (filters.state) params.set("state", filters.state);

  const Icon = !active ? ChevronsUpDown : direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <TableHead
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <Link
        href={`?${params.toString()}`}
        className="inline-flex items-center gap-1 outline-none hover:underline focus-visible:underline"
      >
        {label}
        <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </Link>
    </TableHead>
  );
}

export default async function BookingsPage({ params, searchParams }: BookingsPageProps) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);

  try {
    await requireBookingActor();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      redirect(
        `${getLoginPathForLocale(locale)}?callbackUrl=${encodeURIComponent("/bookings")}`,
      );
    }
    throw error;
  }

  const query = await searchParams;
  const t = await getTranslations({ locale, namespace: "Bookings" });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });

  const sort = isSort(query.sort) ? query.sort : undefined;
  const direction: BookingQueueDirection = query.dir === "asc" ? "asc" : "desc";
  const filters = {
    q: query.q,
    state: isBookingState(query.state) ? query.state : undefined,
  };

  const bookings = await listBookingQueue({
    state: filters.state,
    search: filters.q,
    sort,
    direction,
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">{t("queue.title")}</h1>

      <QueueFilters
        states={BOOKING_STATES}
        search={filters.q ?? ""}
        state={filters.state}
      />

      {/* Filtering happens as the operator types, so the count is announced. */}
      <p role="status" className="text-sm text-muted-foreground">
        {t("queue.count", { count: bookings.length })}
      </p>

      {bookings.length === 0 ? (
        <p className="text-sm text-zinc-600">
          {/* An empty queue and a filter that matches nothing need different advice. */}
          {isBookingState(query.state) || query.q
            ? t("queue.empty")
            : t("queue.noneYet")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableCaption className="sr-only">{t("queue.title")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t("queue.columns.customer")}</TableHead>
                <SortableHead
                  column="submittedAt"
                  label={t("queue.columns.submitted")}
                  sort={sort}
                  direction={direction}
                  filters={filters}
                />
                <SortableHead
                  column="startDate"
                  label={t("queue.columns.stay")}
                  sort={sort}
                  direction={direction}
                  filters={filters}
                />
                <TableHead>{t("queue.columns.group")}</TableHead>
                <SortableHead
                  column="state"
                  label={t("queue.columns.state")}
                  sort={sort}
                  direction={direction}
                  filters={filters}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {bookings.map((booking) => (
                <TableRow
                  key={booking.id}
                  className="relative cursor-pointer focus-within:bg-muted/50 hover:bg-muted/50"
                >
                  <TableCell className="whitespace-normal">
                    {/* The link covers the row, so a click anywhere opens it while
                        the keyboard still has a single, real target. */}
                    <Link
                      href={`/bookings/${booking.id}`}
                      className="font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                    >
                      {booking.customerName}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {booking.taxId}
                    </span>
                  </TableCell>
                  <TableCell>{dateFormat.format(booking.submittedAt)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {dateFormat.format(booking.startDate)} –{" "}
                    {dateFormat.format(booking.endDate)}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {t("queue.people", { count: booking.headcount })}
                    <span className="block text-xs text-muted-foreground">
                      {t(`board.${booking.boardType as "SELF_CATERING" | "FULL_BOARD"}`)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <BookingStateBadge
                      state={booking.state}
                      label={t(`states.${booking.state}`)}
                    />
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
