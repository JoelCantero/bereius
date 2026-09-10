import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ExternalLink } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { noIndexMetadata } from "@/lib/seo";
import { holdedEstimateUrl } from "@/lib/holded/links";
import {
  createContactAction,
  linkEstimateAction,
  updateContactAction,
} from "@/modules/booking/actions/contact";
import {
  approveBookingAction,
  cancelBookingAction,
  recordPaymentAction,
  rejectBookingAction,
} from "@/modules/booking/actions/decisions";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import { ContactSyncButton } from "@/modules/booking/components/contact-sync";
import { DecisionForm, PaymentForm } from "@/modules/booking/components/decision-forms";
import { BookingStateBadge } from "@/modules/booking/components/state-badge";
import { inspectCustomerContact } from "@/modules/booking/services/contact-sync";
import { estimateNamesStay } from "@/modules/booking/services/contracts";
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

  const contact = await inspectCustomerContact(booking.id);
  const linkedEstimateId =
    booking.documents.find((document) => document.type === "ESTIMATE")?.holdedId ?? null;

  // Linking an estimate approves the request, so the picker is only offered
  // while the request is under review and nothing is linked yet, and only for
  // the estimates whose description names this stay's dates.
  const estimates =
    linkedEstimateId === null &&
    booking.state === "IN_REVIEW" &&
    (contact.status === "matches" || contact.status === "differs")
      ? contact.estimates.filter((estimate) =>
          estimateNamesStay(estimate.description, booking.startDate, booking.endDate),
        )
      : null;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-6">
      <div className="flex flex-col items-start gap-2">
        <Link href="/bookings" className="text-sm underline">
          {t("detail.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{booking.customer.name}</h1>
        <BookingStateBadge
          state={booking.state}
          label={t(`states.${booking.state}`)}
        />
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
          <dt className="text-muted-foreground">{t("detail.taxId")}</dt>
          <dd>{booking.customer.taxId}</dd>
          <dt className="text-muted-foreground">{t("detail.email")}</dt>
          <dd>{booking.customer.email}</dd>
          {booking.customer.phone ? (
            <>
              <dt className="text-muted-foreground">{t("detail.phone")}</dt>
              <dd>{booking.customer.phone}</dd>
            </>
          ) : null}
          {booking.customer.addressLine ? (
            <>
              <dt className="text-muted-foreground">{t("detail.address")}</dt>
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

        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p className="font-medium">{t("holdedContact.title")}</p>

          {contact.status === "no_key" || contact.status === "unavailable" ? (
            <p className="text-muted-foreground">{t(`holdedContact.${contact.status}`)}</p>
          ) : null}

          {contact.status === "missing" ? (
            <>
              <p className="text-muted-foreground">{t("holdedContact.missing")}</p>
              <ContactSyncButton
                action={createContactAction}
                bookingRequestId={booking.id}
                label={t("holdedContact.create")}
              />
            </>
          ) : null}

          {contact.status === "matches" ? (
            <p className="text-green-700 dark:text-green-400">{t("holdedContact.matches")}</p>
          ) : null}

          {contact.status === "differs" ? (
            <>
              <p className="text-amber-700 dark:text-amber-400">{t("holdedContact.differs")}</p>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th scope="col" className="py-1">{t("holdedContact.field")}</th>
                    <th scope="col" className="py-1">{t("holdedContact.ours")}</th>
                    <th scope="col" className="py-1">{t("holdedContact.theirs")}</th>
                  </tr>
                </thead>
                <tbody>
                  {contact.differences.map((difference) => (
                    <tr key={difference.field} className="border-t">
                      <td className="py-1 text-muted-foreground">
                        {t(`holdedContact.fields.${difference.field}`)}
                      </td>
                      <td className="py-1">{difference.ours ?? "—"}</td>
                      <td className="py-1">{difference.theirs ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ContactSyncButton
                action={updateContactAction}
                bookingRequestId={booking.id}
                label={t("holdedContact.update")}
              />
            </>
          ) : null}
        </div>
      </section>

      {estimates !== null ? (
        <section aria-labelledby="estimates-heading" className="flex flex-col gap-2">
          <h2 id="estimates-heading" className="text-lg font-medium">
            {t("holdedEstimates.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("holdedEstimates.hint")}</p>

          {estimates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("holdedEstimates.none")}</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {estimates.map((estimate) => (
                <li
                  key={estimate.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                >
                  <span>
                    <span className="font-medium">{estimate.number ?? estimate.id}</span>
                    {estimate.description ? ` · ${estimate.description}` : ""}
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {[estimate.date, cents(estimate.totalCents)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <ContactSyncButton
                    action={linkEstimateAction}
                    bookingRequestId={booking.id}
                    holdedId={estimate.id}
                    label={t("holdedEstimates.link")}
                    variant="secondary"
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-labelledby="amounts-heading" className="flex flex-col gap-1">
        <h2 id="amounts-heading" className="text-lg font-medium">
          {t("detail.amounts")}
        </h2>
        {amountToConfirm === null ? (
          <p className="text-sm text-muted-foreground">{t("detail.pendingQuote")}</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("detail.advance")}</dt>
            <dd>{cents(booking.advanceCents)}</dd>
            <dt className="text-muted-foreground">{t("detail.deposit")}</dt>
            <dd>{cents(booking.depositCents)}</dd>
            <dt className="text-muted-foreground">{t("detail.toConfirm")}</dt>
            <dd className="font-medium">{cents(amountToConfirm)}</dd>
            {booking.paymentDueAt ? (
              <>
                <dt className="text-muted-foreground">{t("detail.paymentDue")}</dt>
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
          <p className="text-sm text-muted-foreground">{t("detail.noDocuments")}</p>
        ) : (
          <ul className="text-sm">
            {booking.documents.map((document) => (
              <li key={document.id}>
                {t(`documentTypes.${document.type}`)}
                {document.type === "ESTIMATE" ? (
                  <>
                    {" · "}
                    <Link
                      href={`/contracts/${document.holdedId}`}
                      className="hover:underline focus-visible:underline"
                    >
                      {document.documentNumber ?? t("detail.openEstimate")}
                    </Link>
                    {" · "}
                    <a
                      href={holdedEstimateUrl(document.holdedId)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-muted-foreground hover:underline focus-visible:underline"
                    >
                      {t("detail.openInHolded")}
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </a>
                  </>
                ) : document.documentNumber ? (
                  ` · ${document.documentNumber}`
                ) : null}
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
          <p className="text-sm text-muted-foreground">{t("detail.noPayments")}</p>
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

        {["AWAITING_PAYMENT", "CONFIRMED"].includes(booking.state) ? (
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
              <span className="text-muted-foreground">
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
