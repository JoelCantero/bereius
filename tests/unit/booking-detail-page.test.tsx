import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/messages/en.json";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getBookingDetail: vi.fn(),
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
        estimateDelivery: { status },
      },
    ],
    payments: [],
    auditEvents: [],
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
});