// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  appNavigation: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `navigation.${key}`),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/app-navigation", () => ({
  AppNavigation: (props: unknown) => {
    mocks.appNavigation(props);
    return null;
  },
}));

import { AppHeader } from "@/components/app-header";

describe("AppHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes authenticated localized navigation state to the shared header", async () => {
    mocks.getServerSession.mockResolvedValue({
      user: {
        id: "user-1",
        name: "Joel Cantero",
        email: "joel@example.com",
        image: "https://example.com/avatar.jpg",
      },
    });

    const markup = renderToStaticMarkup(
      await AppHeader({ locale: "es", projectName: "Example Workspace" }),
    );

    expect(markup).toContain('<a href="/"');
    expect(markup).toContain(">Example Workspace</a>");

    expect(mocks.appNavigation).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticated: true,
        locale: "es",
        labels: expect.objectContaining({
          language: "navigation.language",
        }),
      }),
    );
    // The avatar and its menu live in the console sidebar now.
    expect(mocks.appNavigation.mock.calls[0][0]).not.toHaveProperty("user");
  });
});