import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/bookings",
  signOut: vi.fn(),
  getServerSession: vi.fn(),
  requireBookingActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("next-auth/react", () => ({ signOut: mocks.signOut }));
vi.mock("next-intl/server", () => ({
  getTranslations: () => (key: string) => key,
}));
vi.mock("@/modules/booking/authorization", () => ({
  requireBookingActor: mocks.requireBookingActor,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => mocks.pathname,
  getPathname: ({ href, locale }: { href: string; locale: string }) =>
    `${locale === "en" ? "" : `/${locale}`}${href}`,
}));

import { AppSidebar } from "@/components/app-sidebar";
import type { ConsoleLink, ConsoleSection } from "@/components/console-sections";
import { SidebarProvider } from "@/components/ui/sidebar";
import { buildConsoleNavigation } from "@/modules/console/navigation";

const sections: ConsoleSection[] = [
  {
    key: "bookings",
    label: "Reservas",
    links: [{ href: "/bookings", label: "Cola", description: "Revisa solicitudes." }],
  },
];

const userLinks: ConsoleLink[] = [
  { href: "/account", label: "Perfil", description: "Tu nombre." },
  { href: "/bookings/settings", label: "Integraciones", description: "Credenciales." },
];

function renderSidebar(links: ConsoleLink[] = userLinks) {
  return render(
    <SidebarProvider>
      <AppSidebar
        sections={sections}
        userLinks={links}
        homeHref="/es"
        labels={{
          toggle: "Mostrar u ocultar la navegación",
          menu: "Menú de la cuenta",
          logout: "Cerrar sesión",
        }}
        user={{
          name: "Joel Cantero",
          email: "joel@example.test",
          image: null,
          initials: "JC",
        }}
      />
    </SidebarProvider>,
  );
}

/** Base UI opens on pointer events that jsdom lacks, so the keyboard drives it. */
async function openUserMenu() {
  screen.getByRole("button", { name: "Menú de la cuenta" }).focus();
  await userEvent.keyboard("{Enter}");
}

describe("console sidebar", () => {
  it("groups every link under its own labelled section", () => {
    renderSidebar();

    for (const section of sections) {
      const group = screen.getByRole("group", { name: section.label });

      for (const link of section.links) {
        expect(within(group).getByRole("link", { name: link.label })).toHaveAttribute(
          "href",
          link.href,
        );
      }
    }
  });

  it("marks the page being viewed for assistive technology", () => {
    renderSidebar();

    expect(screen.getByRole("link", { name: "Cola" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps the account and the settings behind the user menu", async () => {
    renderSidebar();

    expect(screen.queryByRole("menuitem", { name: "Perfil" })).toBeNull();
    await openUserMenu();

    expect(screen.getByRole("menuitem", { name: "Perfil" })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(screen.getByRole("menuitem", { name: "Integraciones" })).toHaveAttribute(
      "href",
      "/bookings/settings",
    );
  });

  it("shows only what the caller passed, so a role cannot leak a link", async () => {
    renderSidebar([{ href: "/account", label: "Perfil", description: "Tu nombre." }]);

    await openUserMenu();

    expect(screen.queryByRole("menuitem", { name: "Integraciones" })).toBeNull();
  });

  it("returns to the localised home page after signing out", async () => {
    renderSidebar();

    await openUserMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Cerrar sesión" }));

    expect(mocks.signOut).toHaveBeenCalledWith({ callbackUrl: "/es" });
  });
});

describe("role-filtered console navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue({
      user: {
        name: "Synthetic Operator",
        email: "operator@example.test",
        image: null,
      },
    });
  });

  it.each(["OPERATOR", "ADMINISTRATOR"] as const)(
    "shows bank movements to an %s",
    async (role) => {
      mocks.requireBookingActor.mockResolvedValue({ userId: "actor-id", role });

      const navigation = await buildConsoleNavigation("en");
      const holded = navigation?.sections.find((section) => section.key === "holded");

      expect(holded?.links).toContainEqual({
        href: "/bank-movements",
        label: "links.bankMovements.label",
        description: "links.bankMovements.description",
      });
    },
  );

  it("keeps integration settings out of operator navigation", async () => {
    mocks.requireBookingActor.mockResolvedValue({
      userId: "operator-id",
      role: "OPERATOR",
    });

    const navigation = await buildConsoleNavigation("en");

    expect(navigation?.userLinks.map((link) => link.href)).not.toContain(
      "/bookings/settings",
    );
  });

  it("keeps integration settings available to administrators", async () => {
    mocks.requireBookingActor.mockResolvedValue({
      userId: "administrator-id",
      role: "ADMINISTRATOR",
    });

    const navigation = await buildConsoleNavigation("en");

    expect(navigation?.userLinks.map((link) => link.href)).toContain(
      "/bookings/settings",
    );
  });
});
