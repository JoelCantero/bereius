import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ signOut: vi.fn(), setTheme: vi.fn(), pathname: "/projects" }));

vi.mock("next-auth/react", () => ({ signOut: mocks.signOut }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: mocks.setTheme }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    locale,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    locale?: string;
  }) => (
    <a href={href} data-locale={locale} {...props}>
      {children}
    </a>
  ),
  getPathname: ({ href, locale }: { href: string; locale: string }) =>
    locale === "en" ? href : `/${locale}${href}`,
  usePathname: () => mocks.pathname,
}));

import { AppNavigation } from "@/components/app-navigation";

const labels = {
  ariaLabel: "Account navigation",
  login: "Login",
  signup: "Sign up",
  toggleTheme: "Toggle dark mode",
  language: "Select language",
};

describe("AppNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname = "/projects";
  });

  it.each([
    ["en", "Login", "Sign up"],
    ["es", "Iniciar sesión", "Registrarse"],
    ["ca", "Inicia sessió", "Registra't"],
  ] as const)("shows distinct enabled login and signup links to signed-out %s visitors", (locale, login, signup) => {
    const localizedLabels = { ...labels, login, signup };
    render(
      <AppNavigation
        authenticated={false}
        locale={locale}
        labels={localizedLabels}
      />,
    );

    expect(screen.getByRole("navigation", { name: labels.ariaLabel })).toBeVisible();
    expect(screen.getByRole("link", { name: login })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(screen.getByRole("link", { name: signup })).toHaveAttribute(
      "href",
      "/signup",
    );
    expect(document.querySelector('[data-slot="separator"]')).toBeInTheDocument();
  });

  it("offers a signed-in visitor no account controls, since the console holds them", () => {
    mocks.pathname = "/es/account";
    render(<AppNavigation authenticated locale="es" labels={labels} />);

    expect(screen.queryByRole("link", { name: labels.login })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: labels.signup })).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: labels.toggleTheme }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: labels.language })).toBeInTheDocument();
  });

  it("switches from the resolved light theme to dark mode", async () => {
    render(<AppNavigation authenticated={false} locale="en" labels={labels} />);

    const themeButton = screen.getByRole("button", { name: labels.toggleTheme });
    expect(themeButton).toHaveAttribute("data-slot", "navigation-menu-link");
    expect(themeButton).toHaveAttribute("title", labels.toggleTheme);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.click(themeButton);

    expect(mocks.setTheme).toHaveBeenCalledWith("dark");
  });

  it("switches locale while preserving the active pathname", async () => {
    render(<AppNavigation authenticated={false} locale="es" labels={labels} />);

    await userEvent.click(screen.getByRole("button", { name: labels.language }));

    expect(screen.getByRole("link", { name: "CA" })).toHaveAttribute(
      "href",
      "/ca/projects",
    );
    expect(screen.getByRole("link", { name: "ENG" })).toHaveAttribute(
      "href",
      "/en/projects",
    );
    expect(screen.getByRole("link", { name: "ES" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});