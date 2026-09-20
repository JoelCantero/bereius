import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getBookingDetail: vi.fn(),
  listBookingPaymentCandidates: vi.fn(),
  inspectCustomerContact: vi.fn(),
  requireBookingActor: vi.fn(),
  getTranslations: vi.fn(),
  setRequestLocale: vi.fn(),
}));

function translate(key: string) {
  const value = key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, enMessages.Bookings);
  if (typeof value !== "string") throw new Error(`Missing Bookings.${key}`);
  return value;
}

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
  setRequestLocale: mocks.setRequestLocale,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/holded/links", () => ({
  holdedEstimateUrl: (id: string) => `https://holded.example/estimate/${id}`,
}));
vi.mock("@/modules/booking/authorization", () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  requireBookingActor: mocks.requireBookingActor,
}));
vi.mock("@/modules/booking/services/contact-sync", () => ({
  inspectCustomerContact: mocks.inspectCustomerContact,
}));
vi.mock("@/modules/booking/services/queries", () => ({
  getBookingDetail: mocks.getBookingDetail,
}));
vi.mock("@/modules/banking/services/queries", () => ({
  listBookingPaymentCandidates: mocks.listBookingPaymentCandidates,
}));
vi.mock("@/modules/banking/actions/reconciliation", () => ({
  confirmBookingPaymentCandidateAction: vi.fn(),
  dismissBookingPaymentCandidateAction: vi.fn(),
}));
vi.mock("@/modules/booking/actions/contact", () => ({
  createContactAction: vi.fn(),
  linkEstimateAction: vi.fn(),
  updateContactAction: vi.fn(),
}));
vi.mock("@/modules/booking/actions/decisions", () => ({
  approveBookingAction: vi.fn(),
  cancelBookingAction: vi.fn(),
  recordPaymentAction: vi.fn(),
  rejectBookingAction: vi.fn(),
}));

import BookingDetailPage from "@/app/[locale]/(console)/bookings/[id]/page";

function bookingWithDelivery(status: "ACCEPTED" | "UNKNOWN") {
  return {
    id: "booking-1",
    state: "COMPLETED",
    boardType: "FULL_BOARD",
    startDate: new Date("2027-05-10T00:00:00.000Z"),
    endDate: new Date("2027-05-12T00:00:00.000Z"),
    headcount: 30,
    advanceCents: 20_000,
    depositCents: 10_000,
    paymentDueAt: null,
    customer: {
      name: "Example organisation",
      taxId: "B12345678",
      email: "fiscal@example.test",
      phone: null,
      addressLine: null,
      postalCode: null,
      city: null,
      province: null,
    },
    documents: [
      {
        id: "document-1",
        type: "ESTIMATE",
        holdedId: "estimate-1",
        documentNumber: "P-1",
        delivery: { status },
      },
    ],
    documentIssuances: [],
    payments: [],
    auditEvents: [],
  };
}

function bookingWithReserveInvoice(
  issuanceStatus: "PREPARED" | "ISSUED" | "BLOCKED" | "UNKNOWN",
  deliveryStatus?: "ACCEPTED" | "UNKNOWN",
) {
  const booking = bookingWithDelivery("ACCEPTED");
  return {
    ...booking,
    documents:
      issuanceStatus === "ISSUED"
        ? [
            ...booking.documents,
            {
              id: "document-2",
              type: "RESERVE_INVOICE",
              holdedId: "invoice-1",
              documentNumber: "F-1",
              delivery: deliveryStatus ? { status: deliveryStatus } : null,
            },
          ]
        : booking.documents,
    documentIssuances: [{ status: issuanceStatus }],
  };
}

describe("booking detail estimate delivery warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBookingActor.mockResolvedValue({ id: "operator-1" });
    mocks.inspectCustomerContact.mockResolvedValue({
      status: "no_key",
      differences: [],
      estimates: [],
    });
    mocks.listBookingPaymentCandidates.mockResolvedValue([]);
    mocks.getTranslations.mockResolvedValue(translate);
  });

  it("shows a stable non-PII warning for an unknown Holded outcome", async () => {
    mocks.getBookingDetail.mockResolvedValue(bookingWithDelivery("UNKNOWN"));

    render(
      await BookingDetailPage({
        params: Promise.resolve({ locale: "en", id: "booking-1" }),
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      enMessages.Bookings.detail.deliveryUnknown,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("fiscal@example.test");
  });

  it("does not warn after Holded accepted delivery", async () => {
    mocks.getBookingDetail.mockResolvedValue(bookingWithDelivery("ACCEPTED"));

    render(
      await BookingDetailPage({
        params: Promise.resolve({ locale: "en", id: "booking-1" }),
      }),
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["PREPARED", "reserveInvoiceProcessing"],
    ["ISSUED", "reserveInvoiceSent"],
    ["BLOCKED", "reserveInvoiceBlocked"],
    ["UNKNOWN", "reserveInvoiceUnknown"],
  ] as const)(
    "shows the safe reserve invoice status for %s",
    async (issuanceStatus, messageKey) => {
      mocks.getBookingDetail.mockResolvedValue(
        bookingWithReserveInvoice(
          issuanceStatus,
          issuanceStatus === "ISSUED" ? "ACCEPTED" : undefined,
        ),
      );

      render(
        await BookingDetailPage({
          params: Promise.resolve({ locale: "en", id: "booking-1" }),
        }),
      );

      expect(screen.getByText(enMessages.Bookings.detail[messageKey])).toBeVisible();
    },
  );

  it("shows an unknown invoice delivery without claiming it was sent", async () => {
    mocks.getBookingDetail.mockResolvedValue(
      bookingWithReserveInvoice("ISSUED", "UNKNOWN"),
    );

    render(
      await BookingDetailPage({
        params: Promise.resolve({ locale: "en", id: "booking-1" }),
      }),
    );

    expect(
      screen.getByText(enMessages.Bookings.detail.reserveInvoiceDeliveryUnknown),
    ).toBeVisible();
    expect(
      screen.queryByText(enMessages.Bookings.detail.reserveInvoiceSent),
    ).not.toBeInTheDocument();
  });

  it("shows the exact amount expected to confirm the booking", async () => {
    mocks.getBookingDetail.mockResolvedValue(bookingWithDelivery("ACCEPTED"));

    render(
      await BookingDetailPage({
        params: Promise.resolve({ locale: "en", id: "booking-1" }),
      }),
    );

    const money = new Intl.NumberFormat("en", {
      style: "currency",
      currency: "EUR",
    });
    expect(screen.getByText(money.format(200))).toBeVisible();
    expect(screen.getByText(money.format(100))).toBeVisible();
    expect(screen.getByText(money.format(300))).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Refresh linked estimate" }),
    ).not.toBeInTheDocument();
  });

  it("offers to repair a linked estimate whose payment amounts are missing", async () => {
    mocks.getBookingDetail.mockResolvedValue({
      ...bookingWithDelivery("ACCEPTED"),
      state: "AWAITING_PAYMENT",
      advanceCents: null,
      depositCents: null,
      documents: [
        {
          id: "document-1",
          type: "ESTIMATE",
          holdedId: "6aa65f996fc9e17ce706fe70",
          documentNumber: null,
          totalCents: null,
          delivery: null,
        },
      ],
    });

    const page = await BookingDetailPage({
      params: Promise.resolve({ locale: "en", id: "booking-1" }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={{ Bookings: enMessages.Bookings }}>
        {page}
      </NextIntlClientProvider>,
    );

    expect(
      screen.getByText(
        "The linked estimate is missing information needed to match payments.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Refresh linked estimate" }),
    ).toBeEnabled();
  });

  it("shows matching bank income while a booking awaits payment", async () => {
    const money = new Intl.NumberFormat("en", {
      style: "currency",
      currency: "EUR",
    });
    mocks.getBookingDetail.mockResolvedValue({
      ...bookingWithDelivery("ACCEPTED"),
      state: "AWAITING_PAYMENT",
    });
    mocks.listBookingPaymentCandidates.mockResolvedValue([
      {
        movementId: "movement-1",
        bookingDate: "2026-09-11",
        narrative: "Synthetic payment without estimate reference",
        amountMinor: "31500",
        expectedAmountMinor: "30000",
        differenceMinor: "1500",
        currency: "EUR",
        estimateReferenceFound: false,
      },
    ]);

    const page = await BookingDetailPage({
      params: Promise.resolve({ locale: "en", id: "booking-1" }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={{ Bookings: enMessages.Bookings }}>
        {page}
      </NextIntlClientProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Matching bank income" }),
    ).toBeVisible();
    expect(
      screen.getByText("Synthetic payment without estimate reference"),
    ).toBeVisible();
    expect(screen.getByText(money.format(315))).toBeVisible();
    expect(screen.getAllByText(money.format(300))).toHaveLength(2);
    expect(screen.getByText(money.format(15))).toBeVisible();
    expect(screen.getByText("No estimate reference found")).toBeVisible();
    expect(screen.getByRole("button", { name: "Link payment" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("labels an unnumbered estimate without exposing its Holded id", async () => {
    const holdedId = "6aa65f996fc9e17ce706fe70";
    mocks.getBookingDetail.mockResolvedValue({
      ...bookingWithDelivery("ACCEPTED"),
      state: "IN_REVIEW",
      documents: [],
    });
    mocks.inspectCustomerContact.mockResolvedValue({
      status: "matches",
      contactId: "contact-1",
      differences: [],
      estimates: [
        {
          id: holdedId,
          number: null,
          description: "10/05/27 - 12/05/27 - 30 persones PC",
          date: "2027-05-01",
          totalCents: 170_001,
          status: "draft",
          contactId: "contact-1",
          contactName: "Example organisation",
        },
      ],
    });

    const page = await BookingDetailPage({
      params: Promise.resolve({ locale: "en", id: "booking-1" }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={{ Bookings: enMessages.Bookings }}>
        {page}
      </NextIntlClientProvider>,
    );

    expect(screen.getByText("Estimate without number")).toBeVisible();
    expect(screen.queryByText(holdedId)).not.toBeInTheDocument();
  });
});