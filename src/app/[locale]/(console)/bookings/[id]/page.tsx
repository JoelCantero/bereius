import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { noIndexMetadata } from "@/lib/seo";
import {
  approveBookingAction,
  cancelBookingAction,
  recordPaymentAction,
  rejectBookingAction,
} from "@/modules/booking/actions/decisions";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { DecisionForm, PaymentForm } from "@/modules/booking/components/decision-forms";
import { getBookingDetail } from "@/modules/booking/services/queries";
import { getLoginPathForLocale, parseLoginLocale } from "@/modules/login/schema";

interface BookingDetailPageProps {
  params: Promise<{ locale: string; id: string }>;
}

export async function generateMetadata({
  params,
}: BookingDetailPageProps): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Bookings.detail" });

  return noIndexMetadata({ title: t("title"), description: t("description") });
}

export default async function BookingDetailPage({ params }: BookingDetailPageProps) {
  const { locale: rawLocale, id } = await params;
  const locale = parseLoginLocale(rawLocale);
  setRequestLocale(locale);

  try {
    await requireBookingActor();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      redirect(
        `${getLoginPathForLocale(locale)}?callbackUrl=${encodeURIComponent(`/bookings/${id}`)}`,
      );
    }
    throw error;
  }

  const booking = await getBookingDetail(id);
  if (!booking) notFound();

  const t = await getTranslations({ locale, namespace: "Bookings" });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const cents = (value: number | null) => (value === null ? null : money.format(value / 100));

  const amountToConfirm =
    booking.advanceCents !== null && booking.depositCents !== null
      ? booking.advanceCents + booking.depositCents
      : null;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <Link href="/bookings" className="text-sm underline">
          {t("detail.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{booking.customer.name}</h1>
        <p className="text-sm text-zinc-600">{t(`states.${booking.state}`)}</p>
      </div>

      <section aria-labelledby="stay-heading" className="flex flex-col gap-2">
        <h2 id="stay-heading" className="text-lg font-medium">
          {t("detail.stay")}
        </h2>
        <p className="text-sm">
          {dateFormat.format(booking.startDate)} – {dateFormat.format(booking.endDate)},{" "}
          {t("queue.people", { count: booking.headcount })},{" "}
          {t(`board.${booking.boardType}`)}
        </p>
      </section>

      <section aria-labelledby="customer-heading" className="flex flex-col gap-1">
        <h2 id="customer-heading" className="text-lg font-medium">
          {t("detail.customer")}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-600">{t("detail.taxId")}</dt>
          <dd>{booking.customer.taxId}</dd>
          <dt className="text-zinc-600">{t("detail.email")}</dt>
          <dd>{booking.customer.email}</dd>
          {booking.customer.phone ? (
            <>
              <dt className="text-zinc-600">{t("detail.phone")}</dt>
              <dd>{booking.customer.phone}</dd>
            </>
          ) : null}
          {booking.customer.addressLine ? (
            <>
              <dt className="text-zinc-600">{t("detail.address")}</dt>
              <dd>
                {[
                  booking.customer.addressLine,
                  booking.customer.postalCode,
                  booking.customer.city,
                  booking.customer.province,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="amounts-heading" className="flex flex-col gap-1">
        <h2 id="amounts-heading" className="text-lg font-medium">
          {t("detail.amounts")}
        </h2>
        {amountToConfirm === null ? (
          <p className="text-sm text-zinc-600">{t("detail.pendingQuote")}</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-600">{t("detail.advance")}</dt>
            <dd>{cents(booking.advanceCents)}</dd>
            <dt className="text-zinc-600">{t("detail.deposit")}</dt>
            <dd>{cents(booking.depositCents)}</dd>
            <dt className="text-zinc-600">{t("detail.toConfirm")}</dt>
            <dd className="font-medium">{cents(amountToConfirm)}</dd>
            {booking.paymentDueAt ? (
              <>
                <dt className="text-zinc-600">{t("detail.paymentDue")}</dt>
                <dd>{dateFormat.format(booking.paymentDueAt)}</dd>
              </>
            ) : null}
          </dl>
        )}
      </section>

      <section aria-labelledby="documents-heading" className="flex flex-col gap-1">
        <h2 id="documents-heading" className="text-lg font-medium">
          {t("detail.documents")}
        </h2>
        {booking.documents.length === 0 ? (
          <p className="text-sm text-zinc-600">{t("detail.noDocuments")}</p>
        ) : (
          <ul className="text-sm">
            {booking.documents.map((document) => (
              <li key={document.id}>
                {t(`documentTypes.${document.type}`)}
                {document.documentNumber ? ` · ${document.documentNumber}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="payments-heading" className="flex flex-col gap-1">
        <h2 id="payments-heading" className="text-lg font-medium">
          {t("detail.payments")}
        </h2>
        {booking.payments.length === 0 ? (
          <p className="text-sm text-zinc-600">{t("detail.noPayments")}</p>
        ) : (
          <ul className="text-sm">
            {booking.payments.map((payment) => (
              <li key={payment.id}>
                {cents(payment.amountCents)} · {dateFormat.format(payment.receivedAt)}
                {payment.reference ? ` · ${payment.reference}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="actions-heading" className="flex flex-col gap-4">
        <h2 id="actions-heading" className="sr-only">
          {t("detail.title")}
        </h2>

        {booking.state === "IN_REVIEW" ? (
          <DecisionForm
            action={approveBookingAction}
            bookingRequestId={booking.id}
            expectedFrom="IN_REVIEW"
            label={t("actions.approve")}
          />
        ) : null}

        {booking.state === "IN_REVIEW" ? (
          <DecisionForm
            action={rejectBookingAction}
            bookingRequestId={booking.id}
            expectedFrom={booking.state}
            label={t("actions.reject")}
            requiresReason
            variant="danger"
          />
        ) : null}

        {booking.state === "AWAITING_PAYMENT" ? (
          <PaymentForm action={recordPaymentAction} bookingRequestId={booking.id} />
        ) : null}

        {["APPROVED", "AWAITING_PAYMENT", "CONFIRMED"].includes(booking.state) ? (
          <DecisionForm
            action={cancelBookingAction}
            bookingRequestId={booking.id}
            label={t("actions.cancel")}
            requiresReason
            variant="danger"
          />
        ) : null}
      </section>

      <section aria-labelledby="history-heading" className="flex flex-col gap-1">
        <h2 id="history-heading" className="text-lg font-medium">
          {t("detail.history")}
        </h2>
        <ol className="flex flex-col gap-1 text-sm">
          {booking.auditEvents.map((event) => (
            <li key={event.id}>
              <span className="text-zinc-600">
                {dateTimeFormat.format(event.createdAt)}
              </span>{" "}
              {t(`states.${event.toState}`)} ·{" "}
              {event.actor?.name ?? event.actor?.email ?? t("detail.systemActor")}
              {event.reason ? ` · ${event.reason}` : ""}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
