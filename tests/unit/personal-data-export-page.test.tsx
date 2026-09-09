import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import caMessages from "@/messages/ca.json";
import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  getServerSession: vi.fn(),
  getSessionUserId: vi.fn(),
  readSessionToken: vi.fn(),
  resolveSession: vi.fn(),
  readAuthorization: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  getTranslations: vi.fn(),
  setRequestLocale: vi.fn(),
  panelProps: vi.fn(),
}));

const catalogs = {
  en: enMessages.Account,
  es: esMessages.Account,
  ca: caMessages.Account,
} as const;
type TestLocale = keyof typeof catalogs;

function translator(locale: TestLocale) {
  function translate(key: string) {
    const value = key.split(".").reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[segment];
    }, catalogs[locale]);
    if (typeof value !== "string") throw new Error(`Missing Account.${key}`);
    return value;
  }
  return Object.assign(translate, { raw: translate });
}

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
  setRequestLocale: mocks.setRequestLocale,
}));
vi.mock("@/modules/account/session", () => ({
  getSessionUserId: mocks.getSessionUserId,
}));
vi.mock("@/modules/account/deletion/session", () => ({
  readAccountSessionToken: mocks.readSessionToken,
  resolveActiveAccountSession: mocks.resolveSession,
}));
vi.mock("@/modules/account/data-export/service", () => ({
  readPersonalDataExportAuthorization: mocks.readAuthorization,
}));
vi.mock("@/modules/account/components/account-navigation", () => ({
  AccountNavigation: () => <nav aria-label="account" />,
}));
vi.mock("@/modules/account/data-export/components/data-export-panel", () => ({
  DataExportPanel: (props: unknown) => {
    mocks.panelProps(props);
    return <section aria-label="personal data export" />;
  },
}));
vi.mock("@/modules/account/deletion/components/delete-account-dialog", () => ({
  DeleteAccountDialog: () => <div>delete control</div>,
}));

import AccountDataPage, {
  generateMetadata,
} from "@/app/[locale]/(console)/account/data/page";

describe("personal data export protected page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({
      toString: () => "next-auth.session-token=opaque-session",
    });
    mocks.getServerSession.mockResolvedValue({ user: { id: "private-user" } });
    mocks.getSessionUserId.mockReturnValue("private-user");
    mocks.readSessionToken.mockReturnValue("opaque-session");
    mocks.resolveSession.mockResolvedValue({
      sessionId: "private-session",
      sessionToken: "opaque-session",
      userId: "private-user",
      normalizedEmail: "private@example.test",
      recentlyAuthenticated: true,
    });
    mocks.readAuthorization.mockResolvedValue({
      status: "ready",
      expiresAt: "2026-08-23T12:15:00.000Z",
    });
    mocks.getTranslations.mockImplementation(
      ({ locale, namespace }: { locale: TestLocale; namespace: string }) => {
        if (namespace !== "Account.data.metadata") return translator(locale);
        const metadata = catalogs[locale].data.metadata;
        return (key: "title" | "description") => metadata[key];
      },
    );
  });

  it.each([
    ["en", "/login?callbackUrl=%2Faccount%2Fdata"],
    ["es", "/es/login?callbackUrl=%2Fes%2Faccount%2Fdata"],
    ["ca", "/ca/login?callbackUrl=%2Fca%2Faccount%2Fdata"],
  ] as const)("redirects a signed-out %s request to its fixed local callback", async (locale, path) => {
    mocks.getSessionUserId.mockReturnValue(null);
    await expect(
      AccountDataPage({
        params: Promise.resolve({ locale }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(`REDIRECT:${path}`);
    expect(mocks.readAuthorization).not.toHaveBeenCalled();
  });

  it("projects only generic callback and exact-session authorization before deletion", async () => {
    render(
      await AccountDataPage({
        params: Promise.resolve({ locale: "es" }),
        searchParams: Promise.resolve({ exportState: "ready" }),
      }),
    );

    expect(mocks.readAuthorization).toHaveBeenCalledWith({
      sessionToken: "opaque-session",
    });
    expect(mocks.panelProps).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "es",
        authorizationState: {
          status: "ready",
          expiresAt: "2026-08-23T12:15:00.000Z",
        },
        callbackNotice: { status: "ready", locale: "es" },
      }),
    );
    const serializedProps = JSON.stringify(mocks.panelProps.mock.calls[0]?.[0]);
    expect(serializedProps).not.toMatch(
      /private-user|private-session|opaque-session|private@example\.test/iu,
    );
    const exportSection = screen.getByRole("region", {
      name: "personal data export",
    });
    const deletionHeading = screen.getByRole("heading", {
      name: catalogs.es.data.deletion.title,
    });
    expect(
      exportSection.compareDocumentPosition(deletionHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("renders invalid URL state as a persistent destructive callout", async () => {
    render(
      await AccountDataPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({ state: "invalid_link" }),
      }),
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "alert");
    expect(alert).toHaveClass("text-destructive");
  });

  it.each(["en", "es", "ca"] as const)(
    "returns localized metadata for %s",
    async (locale) => {
      await expect(
        generateMetadata({
          params: Promise.resolve({ locale }),
          searchParams: Promise.resolve({}),
        }),
      ).resolves.toEqual({
        title: catalogs[locale].data.metadata.title,
        description: catalogs[locale].data.metadata.description,
        robots: { index: false, follow: false },
      });
    },
  );
});