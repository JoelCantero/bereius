import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import caMessages from "@/messages/ca.json";
import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  listActiveAccountSessions: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  routerRefresh: vi.fn(),
  routerPush: vi.fn(),
  getTranslations: vi.fn(),
  setRequestLocale: vi.fn(),
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

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: () => ({
    refresh: mocks.routerRefresh,
    push: mocks.routerPush,
  }),
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
vi.mock("@/modules/account/security/service", () => ({
  listActiveAccountSessions: mocks.listActiveAccountSessions,
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import AccountSecurityPage from "@/app/[locale]/(console)/account/security/page";

function cookieStore(value: string) {
  return { toString: () => value };
}

describe("Account Security protected page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue(cookieStore(""));
    mocks.getTranslations.mockImplementation(
      ({ locale }: { locale: TestLocale }) => createAccountTranslator(locale),
    );
  });

  it.each([
    ["en", "/login?callbackUrl=%2Faccount%2Fsecurity"],
    ["es", "/es/login?callbackUrl=%2Fes%2Faccount%2Fsecurity"],
    ["ca", "/ca/login?callbackUrl=%2Fca%2Faccount%2Fsecurity"],
  ] as const)(
    "redirects a signed-out %s request without querying session data",
    async (locale, expectedPath) => {
      await expect(
        AccountSecurityPage({
          params: Promise.resolve({ locale }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow(`REDIRECT:${expectedPath}`);

      expect(mocks.listActiveAccountSessions).not.toHaveBeenCalled();
    },
  );

  it("redirects when the trusted cookie no longer resolves to an active account session", async () => {
    mocks.cookies.mockResolvedValue(
      cookieStore("next-auth.session-token=trusted-session-token"),
    );
    mocks.listActiveAccountSessions.mockResolvedValue(null);

    await expect(
      AccountSecurityPage({
        params: Promise.resolve({ locale: "es" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(
      "REDIRECT:/es/login?callbackUrl=%2Fes%2Faccount%2Fsecurity",
    );
  });

  it("renders the owned projection current-first in immutable newest order without forbidden metadata", async () => {
    mocks.cookies.mockResolvedValue(
      cookieStore("next-auth.session-token=trusted-session-token"),
    );
    mocks.listActiveAccountSessions.mockResolvedValue([
      {
        sessionId: "hidden-current-selector",
        createdAt: "2026-08-20T08:00:00.000Z",
        expires: "2026-08-23T08:00:00.000Z",
        current: true,
        ordinal: 1,
        authenticatedAt: "forbidden-mutable-time",
        email: "forbidden@example.test",
      },
      {
        sessionId: "hidden-newest-selector",
        createdAt: "2026-08-22T10:00:00.000Z",
        expires: "2026-08-24T08:00:00.000Z",
        current: false,
        ordinal: 2,
        ipAddress: "192.0.2.10",
      },
      {
        sessionId: "hidden-equal-z-selector",
        createdAt: "2026-08-22T09:00:00.000Z",
        expires: "2026-08-26T08:00:00.000Z",
        current: false,
        ordinal: 3,
        device: "Invented browser",
      },
      {
        sessionId: "hidden-equal-a-selector",
        createdAt: "2026-08-22T09:00:00.000Z",
        expires: "2026-08-25T08:00:00.000Z",
        current: false,
        ordinal: 4,
      },
      {
        sessionId: "hidden-legacy-selector",
        createdAt: null,
        expires: "2026-08-27T08:00:00.000Z",
        current: false,
        ordinal: 5,
      },
    ]);

    render(
      await AccountSecurityPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(mocks.listActiveAccountSessions).toHaveBeenCalledWith({
      sessionToken: "trusted-session-token",
    });
    expect(screen.getByRole("link", { name: catalogs.en.navigation.security })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const rows = within(
      screen.getByRole("list", { name: "Active account sessions" }),
    ).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(
      rows.map((row) => within(row).getByRole("heading").textContent),
    ).toEqual(["Session 1", "Session 2", "Session 3", "Session 4", "Session 5"]);
    expect(within(rows[0]!).getByText("Current session")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Revoke session" })).toBeInTheDocument();

    const knownStartValues = rows.slice(0, 4).map((row) =>
      row.querySelector('time[data-kind="started"]')?.getAttribute("datetime"),
    );
    expect(knownStartValues).toEqual([
      "2026-08-20T08:00:00.000Z",
      "2026-08-22T10:00:00.000Z",
      "2026-08-22T09:00:00.000Z",
      "2026-08-22T09:00:00.000Z",
    ]);
    expect(within(rows[4]!).getByText(/Started:.*Unavailable/)).toBeInTheDocument();
    expect(rows[4]!.querySelector('time[data-kind="started"]')).toBeNull();

    const markup = document.body.innerHTML;
    for (const forbidden of [
      "hidden-current-selector",
      "hidden-newest-selector",
      "hidden-equal-z-selector",
      "hidden-equal-a-selector",
      "hidden-legacy-selector",
      "forbidden-mutable-time",
      "forbidden@example.test",
      "192.0.2.10",
      "Invented browser",
      "forbidden-session-token",
      "freshness-is-private",
    ]) {
      expect(markup).not.toContain(forbidden);
    }
  });

  it.each([
    {
      locale: "en",
      started: "Aug 20, 2026, 08:00 AM UTC",
      expires: "Aug 23, 2026, 08:00 AM UTC",
    },
    {
      locale: "es",
      started: "20 ago 2026, 08:00 UTC",
      expires: "23 ago 2026, 08:00 UTC",
    },
    {
      locale: "ca",
      started: "20 d’ag. del 2026, 08:00 UTC",
      expires: "23 d’ag. del 2026, 08:00 UTC",
    },
  ] as const)(
    "renders explicit localized times, unavailable starts, and semantic rows in $locale",
    async ({ locale, started, expires }) => {
      const catalog = catalogs[locale];
      mocks.cookies.mockResolvedValue(
        cookieStore("next-auth.session-token=trusted-session-token"),
      );
      mocks.listActiveAccountSessions.mockResolvedValue([
        {
          sessionId: "selector-must-stay-private",
          createdAt: "2026-08-20T08:00:00.000Z",
          expires: "2026-08-23T08:00:00.000Z",
          current: true,
          ordinal: 1,
          authenticatedAt: "freshness-must-stay-private",
          sessionToken: "token-must-stay-private",
          email: "person@example.test",
          ipAddress: "192.0.2.1",
          device: "Invented device",
        },
        {
          sessionId: "legacy-selector-must-stay-private",
          createdAt: null,
          expires: "2026-08-23T08:00:00.000Z",
          current: false,
          ordinal: 2,
        },
      ]);

      render(
        await AccountSecurityPage({
          params: Promise.resolve({ locale }),
          searchParams: Promise.resolve({}),
        }),
      );

      const list = screen.getByRole("list", {
        name: catalog.security.list.ariaLabel,
      });
      expect(list.tagName).toBe("OL");
      expect(list).toHaveAttribute(
        "aria-describedby",
        "active-sessions-description",
      );
      expect(screen.getByText(catalog.security.list.description)).toHaveAttribute(
        "id",
        "active-sessions-description",
      );

      const rows = within(list).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.tagName === "LI")).toBe(true);
      expect([...list.children].every((child) => child.tagName === "LI")).toBe(true);
      expect(within(list).queryByRole("separator")).not.toBeInTheDocument();
      expect(list.querySelector('[data-slot="item"]')).not.toBeInTheDocument();
      expect(rows[0]).toHaveAttribute("aria-current", "true");
      expect(rows[1]).not.toHaveAttribute("aria-current");
      expect(within(rows[0]!).getByRole("heading")).toHaveTextContent(
        catalog.security.list.sessionLabel.replace("{number}", "1"),
      );
      const currentLabel = within(rows[0]!).getByText(
        catalog.security.list.current,
      );
      expect(currentLabel).toHaveAttribute("data-slot", "badge");
      expect(currentLabel).toHaveAttribute("id");
      expect(rows[0]!.getAttribute("aria-describedby")).toContain(
        currentLabel.id,
      );

      const startedTime = rows[0]!.querySelector(
        'time[data-kind="started"]',
      );
      const expiresTime = rows[0]!.querySelector(
        'time[data-kind="expires"]',
      );
      expect(startedTime).toHaveAttribute(
        "datetime",
        "2026-08-20T08:00:00.000Z",
      );
      expect(startedTime).toHaveTextContent(started);
      expect(expiresTime).toHaveAttribute(
        "datetime",
        "2026-08-23T08:00:00.000Z",
      );
      expect(expiresTime).toHaveTextContent(expires);
      expect(rows[1]!).toHaveTextContent(
        catalog.security.timestamps.startedAt.replace(
          "{date}",
          catalog.security.timestamps.unavailable,
        ),
      );
      expect(
        rows[1]!.querySelector('time[data-kind="started"]'),
      ).not.toBeInTheDocument();

      const markup = document.body.innerHTML;
      for (const forbidden of [
        "selector-must-stay-private",
        "legacy-selector-must-stay-private",
        "freshness-must-stay-private",
        "token-must-stay-private",
        "person@example.test",
        "192.0.2.1",
        "Invented device",
      ]) {
        expect(markup).not.toContain(forbidden);
      }
    },
  );

  it("renders a current-only state with no selectable row and a disabled bulk control", async () => {
    mocks.cookies.mockResolvedValue(
      cookieStore("next-auth.session-token=trusted-session-token"),
    );
    mocks.listActiveAccountSessions.mockResolvedValue([
      {
        sessionId: "hidden-current-selector",
        createdAt: null,
        expires: "2026-08-23T08:00:00.000Z",
        current: true,
        ordinal: 1,
      },
    ]);

    render(
      await AccountSecurityPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getByText(catalogs.en.security.list.currentOnly)).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: catalogs.en.security.actions.revokeOtherSessions,
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", {
        name: catalogs.en.security.actions.revokeSession,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText(catalogs.en.security.list.current),
    ).toHaveLength(1);
  });

  it("renders only allowlisted generic callback notices and carries no action selection", async () => {
    mocks.cookies.mockResolvedValue(
      cookieStore("next-auth.session-token=trusted-session-token"),
    );
    mocks.listActiveAccountSessions.mockResolvedValue([
      {
        sessionId: "hidden-current-selector",
        createdAt: "2026-08-22T08:00:00.000Z",
        expires: "2026-08-23T08:00:00.000Z",
        current: true,
        ordinal: 1,
      },
    ]);

    render(
      await AccountSecurityPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({
          state: "invalid_link",
          sessionId: "must-not-survive",
          action: "revoke_session",
        }),
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      catalogs.en.security.errors.invalidLink,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("must-not-survive");
    expect(document.body.innerHTML).not.toContain("revoke_session");
  });

  it.each([
    [
      "es",
      "reauthenticated",
      "status",
      catalogs.es.security.success.reauthenticated,
    ],
    [
      "ca",
      "session_conflict",
      "alert",
      catalogs.ca.security.errors.sessionConflict,
    ],
  ] as const)(
    "renders the allowlisted %s %s notice from its message catalog",
    async (locale, state, role, notice) => {
      mocks.cookies.mockResolvedValue(
        cookieStore("next-auth.session-token=trusted-session-token"),
      );
      mocks.listActiveAccountSessions.mockResolvedValue([
        {
          sessionId: "hidden-current-selector",
          createdAt: "2026-08-22T08:00:00.000Z",
          expires: "2026-08-23T08:00:00.000Z",
          current: true,
          ordinal: 1,
        },
      ]);

      render(
        await AccountSecurityPage({
          params: Promise.resolve({ locale }),
          searchParams: Promise.resolve({ state }),
        }),
      );

      expect(screen.getByRole(role)).toHaveTextContent(notice);
      expect(screen.getByRole(role)).toHaveAttribute("data-slot", "alert");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("renders the allowlisted recovered notice from an authoritative server projection and focuses its list heading", async () => {
    mocks.cookies.mockResolvedValue(
      cookieStore("next-auth.session-token=trusted-session-token"),
    );
    mocks.listActiveAccountSessions.mockResolvedValue([
      {
        sessionId: "hidden-current-selector",
        createdAt: "2026-08-22T08:00:00.000Z",
        expires: "2026-08-23T08:00:00.000Z",
        current: true,
        ordinal: 1,
      },
    ]);

    render(
      await AccountSecurityPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({
          state: "recovered",
          action: "revoke_session",
          sessionId: "must-not-survive",
        }),
      }),
    );

    expect(mocks.listActiveAccountSessions).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(
      catalogs.en.security.recovery.recovered,
    );
    const heading = screen.getByRole("heading", { name: "Active sessions" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("must-not-survive");
    expect(document.body.innerHTML).not.toContain("revoke_session");
  });

  it.each([
    "recovered?sessionId=hidden",
    "revocation_completed",
    ["recovered"],
  ])("ignores a non-allowlisted page state %j", async (state) => {
    mocks.cookies.mockResolvedValue(
      cookieStore("next-auth.session-token=trusted-session-token"),
    );
    mocks.listActiveAccountSessions.mockResolvedValue([
      {
        sessionId: "hidden-current-selector",
        createdAt: "2026-08-22T08:00:00.000Z",
        expires: "2026-08-23T08:00:00.000Z",
        current: true,
        ordinal: 1,
      },
    ]);

    render(
      await AccountSecurityPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({ state }),
      }),
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});