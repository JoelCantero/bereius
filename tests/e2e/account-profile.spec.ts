import { test, expect } from "@playwright/test";
import { source as axeSource } from "axe-core";

import {
  cleanupAuthenticatedUsers,
  installAuthSessionCookie,
  seedAuthenticatedUser,
} from "./helpers/authenticated-user";

test.afterEach(async () => {
  await cleanupAuthenticatedUsers();
});

test("redirects signed-out account routes to localized login callbacks", async ({ page }) => {
  const targets = [
    ["/account", "/login?callbackUrl=%2Faccount"],
    ["/es/account", "/es/login?callbackUrl=%2Fes%2Faccount"],
    ["/ca/account", "/ca/login?callbackUrl=%2Fca%2Faccount"],
  ] as const;

  for (const [path, expected] of targets) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
});

test("renders authenticated profile, supports update+reload, and checks accessibility", async ({
  page,
  context,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser({ name: "Profile User", image: null });
  await installAuthSessionCookie(context, seeded.sessionToken, baseURL ?? "http://127.0.0.1:3100");
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (
      request.failure()?.errorText === "net::ERR_ABORTED" &&
      request.url().includes("_rsc=")
    ) {
      return;
    }
    browserErrors.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });

  await page.goto("/account");
  await expect(
    page.getByText(process.env.PROJECT_NAME ?? "playwright", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Account navigation" })).toBeVisible();
  // The account lives in the console sidebar rather than the header.
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  const avatar = page.getByLabel("Profile avatar");
  await expect(avatar).toContainText("PU");

  const nameField = page.getByRole("textbox", { name: "Name" });
  await expect(nameField).toHaveValue("Profile User");
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(seeded.email);
  await page.waitForLoadState("networkidle");
  expect(browserErrors).toEqual([]);

  await nameField.fill("Profile User Updated");
  await nameField.press("Enter");
  await expect(page.getByText("Your profile changes were saved.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Profile User Updated");

  await page.evaluate(axeSource);
  const results: {
    violations: Array<{
      nodes: Array<{ impact?: string | null }>;
    }>;
  } = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    return axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  });
  const seriousOrCritical = results.violations.filter((violation) =>
    violation.nodes.some((node) => ["serious", "critical"].includes(node.impact ?? "")),
  );
  expect(seriousOrCritical).toEqual([]);
});

test("renders every locale and theme with long content and avatar fallback", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  const seeded = await seedAuthenticatedUser({
    name: "Alexandra Montserrat de la Vall d'Hebron",
    email: `long-localized-profile-address-${crypto.randomUUID()}@subdomain.example.test`,
    image: "/api/health/missing-avatar",
  });
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);

  const locales = [
    { locale: "en", path: "/account", heading: "Profile", avatar: "Profile avatar" },
    { locale: "es", path: "/es/account", heading: "Perfil", avatar: "Avatar del perfil" },
    { locale: "ca", path: "/ca/account", heading: "Perfil", avatar: "Avatar del perfil" },
  ] as const;

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const target of locales) {
      await context.addCookies([
        {
          name: "NEXT_LOCALE",
          value: target.locale,
          url: new URL(appUrl).origin,
          sameSite: "Lax",
        },
      ]);
      await page.goto(target.path);
      await expect(page.locator("html")).toHaveAttribute("lang", target.locale);
      await expect(page.getByRole("heading", { name: target.heading })).toBeVisible();
      await expect(page.getByLabel(target.avatar)).toContainText("AD");
      await expect(page.getByRole("textbox", { name: /Name|Nombre|Nom/ })).toHaveValue(
        seeded.name,
      );
      await expect(page.getByRole("textbox", { name: /Email|Correo electr.nico|Correu electr.nic/ })).toHaveValue(
        seeded.email,
      );

      const hasOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasOverflow).toBe(false);
      await page.screenshot({
        path: testInfo.outputPath(`${target.locale}-${theme}.png`),
        fullPage: true,
      });
    }
  }
});

test(
  "keeps layout without horizontal overflow at 320px viewport",
  { tag: "@mobile" },
  async ({ page, context, baseURL }) => {
    const seeded = await seedAuthenticatedUser({
      name: "Long Profile Name For Mobile Width Validation",
      email: `mobile-${crypto.randomUUID()}@example.test`,
    });
    await installAuthSessionCookie(
      context,
      seeded.sessionToken,
      baseURL ?? "http://127.0.0.1:3100",
    );

    await page.goto("/es/account");
    await expect(page.getByRole("heading", { name: "Perfil" })).toBeVisible();

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth;
    });
    expect(overflow).toBe(false);
  },
);