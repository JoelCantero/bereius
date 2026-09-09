import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/bookings" }));

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
}));

import { AppSidebar, type ConsoleSection } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

const sections: ConsoleSection[] = [
  {
    key: "bookings",
    label: "Reservas",
    links: [
      { href: "/bookings", label: "Cola", description: "Revisa solicitudes." },
      {
        href: "/bookings/settings",
        label: "Integraciones",
        description: "Credenciales.",
      },
    ],
  },
  {
    key: "account",
    label: "Cuenta",
    links: [{ href: "/account", label: "Perfil", description: "Tu nombre." }],
  },
];

function renderSidebar(given: ConsoleSection[] = sections) {
  return render(
    <SidebarProvider>
      <AppSidebar sections={given} toggleLabel="Mostrar u ocultar la navegación" />
    </SidebarProvider>,
  );
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
    expect(screen.getByRole("link", { name: "Perfil" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows only what the caller passed, so a role cannot leak a link", () => {
    renderSidebar([
      {
        key: "bookings",
        label: "Reservas",
        links: [{ href: "/bookings", label: "Cola", description: "Revisa solicitudes." }],
      },
    ]);

    expect(screen.queryByRole("link", { name: "Integraciones" })).toBeNull();
  });

  it("names the collapse control instead of leaving the shipped English label", () => {
    renderSidebar();

    expect(
      screen.getByRole("button", { name: "Mostrar u ocultar la navegación" }),
    ).toBeInTheDocument();
  });
});
