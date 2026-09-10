import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buttonVariants } from "@/components/ui/button";
import caMessages from "@/messages/ca.json";
import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  getServerSession: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  getTranslations: vi.fn(),
  setRequestLocale: vi.fn(),
  getCurrentUserProfile: vi.fn(),
  resolveActiveAccountSession: vi.fn(),
  readPersonalDataExportAuthorization: vi.fn(),
  listActiveAccountSessions: vi.fn(),
  locale: "en",
}));

const catalogs = {
  en: enMessages.Account,
  es: esMessages.Account,
  ca: caMessages.Account,
} as const;

type TestLocale = keyof typeof catalogs;

function createAccountTranslator(locale: TestLocale) {
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

vi.mock("next-auth", () => ({
  getServerSession: mocks.getServerSession,
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a
      href={mocks.locale === "en" ? href : `/${mocks.locale}${href}`}
      {...props}
    >
      {children}
    </a>
  ),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
  setRequestLocale: mocks.setRequestLocale,
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/modules/account/service", () => ({
  getCurrentUserProfile: mocks.getCurrentUserProfile,
}));
vi.mock("@/modules/account/actions/update-profile", () => ({
  updateProfile: vi.fn(),
}));
vi.mock("@/modules/account/components/profile-form", () => ({
  ProfileForm: () => <h1>Profile content</h1>,
}));
vi.mock("@/modules/account/deletion/components/delete-account-dialog", () => ({
  DeleteAccountDialog: () => null,
}));
vi.mock("@/modules/account/deletion/session", () => ({
  readAccountSessionToken: () => "trusted-session-token",
  resolveActiveAccountSession: mocks.resolveActiveAccountSession,
}));
vi.mock("@/modules/account/data-export/service", () => ({
  readPersonalDataExportAuthorization:
    mocks.readPersonalDataExportAuthorization,
}));
vi.mock("@/modules/account/security/service", () => ({
  listActiveAccountSessions: mocks.listActiveAccountSessions,
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import AccountPage, {
  generateMetadata as generateAccountMetadata,
} from "@/app/[locale]/(console)/account/page";
import AccountDataPage, {
  generateMetadata as generateAccountDataMetadata,
} from "@/app/[locale]/(console)/account/data/page";
import AccountDeletedPage, {
  generateMetadata as generateAccountDeletedMetadata,
} from "@/app/[locale]/account-deleted/page";
import AccountSecurityPage, {
  generateMetadata as generateAccountSecurityMetadata,
} from "@/app/[locale]/(console)/account/security/page";

describe("account route authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.locale = "en";
    mocks.getTranslations.mockImplementation(
      ({ locale }: { locale: TestLocale }) => createAccountTranslator(locale),
    );
    mocks.setRequestLocale.mockImplementation((locale: TestLocale) => {
      mocks.locale = locale;
    });
    mocks.cookies.mockResolvedValue({
      toString: () => "next-auth.session-token=trusted-session-token",
    });
    mocks.getCurrentUserProfile.mockResolvedValue({
      name: "Account User",
      email: "account@example.test",
      image: null,
    });
    mocks.resolveActiveAccountSession.mockResolvedValue({
      sessionId: "trusted-session-id",
      sessionToken: "trusted-session-token",
      userId: "account-user-id",
      email: "account@example.test",
      normalizedEmail: "account@example.test",
      recentlyAuthenticated: true,
    });
    mocks.readPersonalDataExportAuthorization.mockResolvedValue({
      status: "not_ready",
    });
    mocks.listActiveAccountSessions.mockResolvedValue([
      {
        sessionId: "hidden-current-selector",
        createdAt: "2026-08-22T08:00:00.000Z",
        expires: "2026-08-23T08:00:00.000Z",
        current: true,
        ordinal: 1,
      },
    ]);
    mocks.getServerSession.mockResolvedValue(null);
  });

  it("prevents all account pages from being indexed", async () => {
    mocks.getTranslations.mockResolvedValue(() => "Account metadata");
    const params = Promise.resolve({ locale: "en" });
    const searchParams = Promise.resolve({});
    const metadata = await Promise.all([
      generateAccountMetadata({ params }),
      generateAccountDataMetadata({ params, searchParams }),
      generateAccountDeletedMetadata({ params }),
      generateAccountSecurityMetadata({ params, searchParams }),
    ]);

    for (const pageMetadata of metadata) {
      expect(pageMetadata.robots).toEqual({ index: false, follow: false });
    }
  });

  it("keeps the account-deleted action a localized link with shared button styling", async () => {
    mocks.getTranslations.mockResolvedValue((key: string) =>
      key === "title" ? "Account deleted" : key === "description" ? "Done" : "Home",
    );

    render(await AccountDeletedPage({ params: Promise.resolve({ locale: "es" }) }));

    const homeLink = screen.getByRole("link", { name: "Home" });
    expect(homeLink).toHaveAttribute("href", "/es/");
    for (const className of buttonVariants({ size: "lg", className: "w-fit" }).split(" ")) {
      expect(homeLink).toHaveClass(className);
    }
  });

  it.each([
    ["en", "/login?callbackUrl=%2Faccount"],
    ["es", "/es/login?callbackUrl=%2Fes%2Faccount"],
    ["ca", "/ca/login?callbackUrl=%2Fca%2Faccount"],
  ] as const)("redirects signed-out %s requests to localized login", async (locale, expectedPath) => {
    await expect(
      AccountPage({ params: Promise.resolve({ locale }) }),
    ).rejects.toThrow(`REDIRECT:${expectedPath}`);

    expect(mocks.getCurrentUserProfile).not.toHaveBeenCalled();
  });

  it.each(
    (["en", "es", "ca"] as const).flatMap((locale) => [
      {
        locale,
        active: "profile" as const,
        renderPage: () =>
          AccountPage({ params: Promise.resolve({ locale }) }),
      },
      {
        locale,
        active: "data" as const,
        renderPage: () =>
          AccountDataPage({
            params: Promise.resolve({ locale }),
            searchParams: Promise.resolve({}),
          }),
      },
      {
        locale,
        active: "security" as const,
        renderPage: () =>
          AccountSecurityPage({
            params: Promise.resolve({ locale }),
            searchParams: Promise.resolve({}),
          }),
      },
    ]),
  )(
    "preserves $locale navigation and marks only $active current",
    async ({ locale, active, renderPage }) => {
      mocks.getServerSession.mockResolvedValue({
        user: { id: "account-user-id" },
      });
      const catalog = catalogs[locale];

      render(await renderPage());

      const navigation = screen.getByRole("navigation", {
        name: catalog.navigation.profileAriaLabel,
      });
      const prefix = locale === "en" ? "" : `/${locale}`;
      const destinations = [
        [catalog.navigation.profile, `${prefix}/account`, "profile"],
        [catalog.navigation.dataAndPrivacy, `${prefix}/account/data`, "data"],
        [catalog.navigation.security, `${prefix}/account/security`, "security"],
      ] as const;

      for (const [name, href] of destinations) {
        expect(within(navigation).getByRole("link", { name })).toHaveAttribute(
          "href",
          href,
        );
      }

      const currentLinks = within(navigation)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page");
      expect(currentLinks).toHaveLength(1);
      expect(currentLinks[0]).toBe(
        within(navigation).getByRole("link", {
          name: destinations.find(([, , key]) => key === active)![0],
        }),
      );
      expect(within(navigation).queryByRole("tab")).not.toBeInTheDocument();
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    },
  );
});