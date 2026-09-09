import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import type { BookingState } from "@/generated/prisma/enums";
import { noIndexMetadata } from "@/lib/seo";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { listBookingQueue } from "@/modules/booking/services/queries";
import { getLoginPathForLocale, parseLoginLocale } from "@/modules/login/schema";

interface BookingsPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ state?: string; q?: string }>;
}

const BOOKING_STATES: readonly BookingState[] = [
  "RECEIVED",
  "IN_REVIEW",
  "APPROVED",
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

  const bookings = await listBookingQueue({
    state: isBookingState(query.state) ? query.state : undefined,
    search: query.q,
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">{t("queue.title")}</h1>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="q" className="text-sm font-medium">
            {t("queue.searchLabel")}
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
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
            defaultValue={query.state ?? ""}
            className="rounded-md border border-zinc-300 p-2 text-sm"
          >
            <option value="">{t("queue.allStates")}</option>
            {BOOKING_STATES.map((state) => (
              <option key={state} value={state}>
                {t(`states.${state}`)}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
        >
          {t("queue.searchAction")}
        </button>
      </form>

      {bookings.length === 0 ? (
        <p className="text-sm text-zinc-600">{t("queue.empty")}</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{t("queue.title")}</caption>
          <thead>
            <tr className="border-b border-zinc-300 text-left">
              <th scope="col" className="py-2">{t("queue.columns.customer")}</th>
              <th scope="col" className="py-2">{t("queue.columns.stay")}</th>
              <th scope="col" className="py-2">{t("queue.columns.group")}</th>
              <th scope="col" className="py-2">{t("queue.columns.state")}</th>
              <th scope="col" className="py-2">
                <span className="sr-only">{t("queue.open")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((booking) => (
              <tr key={booking.id} className="border-b border-zinc-200">
                <td className="py-2">
                  <span className="font-medium">{booking.customerName}</span>
                  <span className="block text-xs text-zinc-600">{booking.taxId}</span>
                </td>
                <td className="py-2">
                  {dateFormat.format(booking.startDate)} – {dateFormat.format(booking.endDate)}
                </td>
                <td className="py-2">
                  {t("queue.people", { count: booking.headcount })}
                  <span className="block text-xs text-zinc-600">
                    {t(`board.${booking.boardType as "SELF_CATERING" | "FULL_BOARD"}`)}
                  </span>
                </td>
                <td className="py-2">{t(`states.${booking.state}`)}</td>
                <td className="py-2 text-right">
                  <Link href={`/bookings/${booking.id}`} className="underline">
                    {t("queue.open")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
