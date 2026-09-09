import { expect, test, type Page } from "@playwright/test";
import { source as axeSource } from "axe-core";

import {
  cleanupAuthenticatedUsers,
  installAuthSessionCookie,
  seedAuthenticatedUser,
} from "./helpers/authenticated-user";

const englishRoutes = ["/", "/login", "/terms", "/privacy"] as const;

const localeTargets = [
  {
    locale: "en",
    navigationName: "Legal information",
    termsLabel: "Terms of Use",
    privacyLabel: "Privacy Notice",
    accountNavigation: "Account navigation",
    accountLabel: "Account",
    loginLabel: "Login",
    languageLabel: "Select language",
    paths: {
      home: "/",
      login: "/login",
      account: "/account",
      terms: "/terms",
      privacy: "/privacy",
    },
  },
  {
    locale: "es",
    navigationName: "Información legal",
    termsLabel: "Términos de uso",
    privacyLabel: "Aviso de privacidad",
    accountNavigation: "Navegación de cuenta",
    accountLabel: "Cuenta",
    loginLabel: "Iniciar sesión",
    languageLabel: "Seleccionar idioma",
    paths: {
      home: "/es",
      login: "/es/login",
      account: "/es/account",
      terms: "/es/terms",
      privacy: "/es/privacy",
    },
  },
  {
    locale: "ca",
    navigationName: "Informació legal",
    termsLabel: "Condicions d'ús",
    privacyLabel: "Avís de privacitat",
    accountNavigation: "Navegació del compte",
    accountLabel: "Compte",
    loginLabel: "Inicia sessió",
    languageLabel: "Selecciona l'idioma",
    paths: {
      home: "/ca",
      login: "/ca/login",
      account: "/ca/account",
      terms: "/ca/terms",
      privacy: "/ca/privacy",
    },
  },
] as const;

type LocaleTarget = (typeof localeTargets)[number];

const routeMatrix = [
  ...localeTargets.flatMap((target) =>
    (["home", "login", "terms", "privacy"] as const).map((category) => ({
      target,
      category,
      path: target.paths[category],
      authenticated: false,
    })),
  ),
  ...localeTargets.map((target) => ({
    target,
    category: "account" as const,
    path: target.paths.account,
    authenticated: true,
  })),
];

const footerViewports = [
  { name: "mobile", width: 320, height: 568 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  await cleanupAuthenticatedUsers();
});

async function expectNoSeriousAxeViolations(
  page: Page,
  rootSelector?: string,
) {
  await page.evaluate(axeSource);
  const results: {
    violations: Array<{
      id: string;
      nodes: Array<{ impact?: string | null }>;
    }>;
  } = await page.evaluate(async (selector) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const root = selector ? document.querySelector(selector) : document;
    if (!root) throw new Error(`Missing axe root ${selector}`);
    return axe.run(root, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
  }, rootSelector);
  const seriousOrCritical = results.violations.filter((violation) =>
    violation.nodes.some((node) =>
      ["serious", "critical"].includes(node.impact ?? ""),
    ),
  );

  expect(seriousOrCritical).toEqual([]);
}

async function expectFooterContract(page: Page, target: LocaleTarget) {
  const footer = page.getByRole("contentinfo");
  const navigation = footer.getByRole("navigation", {
    name: target.navigationName,
  });
  const links = navigation.getByRole("link");

  await expect(footer).toHaveCount(1);
  await expect(navigation).toHaveCount(1);
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveText(target.termsLabel);
  await expect(links.nth(0)).toHaveAttribute("href", target.paths.terms);
  await expect(links.nth(1)).toHaveText(target.privacyLabel);
  await expect(links.nth(1)).toHaveAttribute("href", target.paths.privacy);

  return { footer, navigation, links };
}

async function expectPageContract(
  page: Page,
  target: LocaleTarget,
  authenticated: boolean,
) {
  await expect(page.locator("html")).toHaveAttribute("lang", target.locale);

  const accountNavigation = page.getByRole("navigation", {
    name: target.accountNavigation,
  });
  if (authenticated) {
    // The account menu moved to the console sidebar; the header keeps only
    // the language and theme controls.
    await expect(
      accountNavigation.getByRole("button", {
        name: target.accountLabel,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      accountNavigation.getByRole("link", {
        name: target.loginLabel,
        exact: true,
      }),
    ).toHaveCount(0);
  } else {
    await expect(
      accountNavigation.getByRole("link", {
        name: target.loginLabel,
        exact: true,
      }),
    ).toBeVisible();
  }

  const contract = await expectFooterContract(page, target);
  expect(
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const footer = document.querySelector("footer");
      return Boolean(
        main &&
          footer &&
          main.compareDocumentPosition(footer) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await expectNoSeriousAxeViolations(page);

  return contract;
}

async function getFooterGeometry(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const footer = document.querySelector("footer");
    if (!main || !footer) throw new Error("Expected main and footer elements");

    const mainRect = main.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    return {
      mainBottom: mainRect.bottom,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
      viewportHeight: window.innerHeight,
      position: getComputedStyle(footer).position,
      followsMain: Boolean(
        main.compareDocumentPosition(footer) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      hasHorizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    };
  });
}

async function expectNormalFlowGeometry(page: Page) {
  const geometry = await getFooterGeometry(page);

  expect(geometry.followsMain).toBe(true);
  expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.mainBottom - 1);
  expect(["fixed", "sticky"]).not.toContain(geometry.position);
  expect(geometry.hasHorizontalOverflow).toBe(false);

  return geometry;
}

async function expectMinimumTargetHeight(page: Page) {
  const targetHeights = await page
    .getByRole("contentinfo")
    .getByRole("link")
    .evaluateAll((links) =>
      links.map((link) => link.getBoundingClientRect().height),
    );

  expect(targetHeights).toHaveLength(3);
  for (const height of targetHeights) expect(height).toBeGreaterThanOrEqual(24);
}

async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function expectVisibleFocus(target: ReturnType<Page["getByRole"]>) {
  const focusStyle = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  const hasOutline =
    focusStyle.outlineStyle !== "none" &&
    Number.parseFloat(focusStyle.outlineWidth) > 0;

  expect(hasOutline || focusStyle.boxShadow !== "none").toBe(true);
}

async function expectEnglishFooter(page: Page, path: string) {
  await page.goto(path);

  const footer = page.getByRole("contentinfo");
  const navigation = footer.getByRole("navigation", {
    name: "Legal information",
  });
  const links = navigation.getByRole("link");

  await expect(footer).toHaveCount(1);
  await expect(navigation).toHaveCount(1);
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveText("Terms of Use");
  await expect(links.nth(0)).toHaveAttribute("href", "/terms");
  await expect(links.nth(1)).toHaveText("Privacy Notice");
  await expect(links.nth(1)).toHaveAttribute("href", "/privacy");
  await expect(navigation.getByRole("button")).toHaveCount(0);

  expect(
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const footerElement = document.querySelector("footer");
      return Boolean(
        main &&
          footerElement &&
          main.compareDocumentPosition(footerElement) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);

  return Promise.all(
    [links.nth(0), links.nth(1)].map(async (link) => ({
      name: (await link.textContent())?.trim(),
      href: await link.getAttribute("href"),
    })),
  );
}

test("keeps the English legal footer global and authentication-independent", async ({
  page,
  context,
  baseURL,
}) => {
  let signedOutContract: Awaited<ReturnType<typeof expectEnglishFooter>> | undefined;

  for (const path of englishRoutes) {
    const contract = await expectEnglishFooter(page, path);
    signedOutContract ??= contract;
    expect(contract).toEqual(signedOutContract);
  }

  const seeded = await seedAuthenticatedUser();
  await installAuthSessionCookie(
    context,
    seeded.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );

  expect(await expectEnglishFooter(page, "/account")).toEqual(
    signedOutContract,
  );
});

test("keeps localized legal navigation complete across the route matrix", async ({
  page,
  context,
  baseURL,
}) => {
  for (const row of routeMatrix.filter((entry) => !entry.authenticated)) {
    await test.step(`${row.target.locale} signed-out ${row.category}`, async () => {
      await page.goto(row.path);
      const { links } = await expectPageContract(page, row.target, false);

      for (const [index, destination] of [
        row.target.paths.terms,
        row.target.paths.privacy,
      ].entries()) {
        await links.nth(index).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(destination);
        await expect(page.locator("html")).toHaveAttribute(
          "lang",
          row.target.locale,
        );
        await page.goto(row.path);
      }
    });
  }

  const seeded = await seedAuthenticatedUser();
  await installAuthSessionCookie(
    context,
    seeded.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );

  for (const row of routeMatrix.filter((entry) => entry.authenticated)) {
    await test.step(`${row.target.locale} authenticated account`, async () => {
      await page.goto(
        row.target.locale === "en" ? "/en" : row.target.paths.home,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        row.target.locale,
      );
      await page.goto(row.path);
      const { links } = await expectPageContract(page, row.target, true);

      for (const [index, destination] of [
        row.target.paths.terms,
        row.target.paths.privacy,
      ].entries()) {
        await links.nth(index).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(destination);
        await expect(page.locator("html")).toHaveAttribute(
          "lang",
          row.target.locale,
        );
        await page.goto(row.path);
      }
    });
  }
});

test("uses a newly selected locale for the next footer destination", async ({
  page,
}) => {
  const english = localeTargets[0];
  const spanish = localeTargets[1];

  await page.goto(english.paths.home);
  const accountNavigation = page.getByRole("navigation", {
    name: english.accountNavigation,
  });
  await accountNavigation
    .getByRole("button", { name: english.languageLabel })
    .click();
  await page.getByRole("link", { name: "ES", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(spanish.paths.home);

  const { links } = await expectFooterContract(page, spanish);
  await links.nth(0).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(spanish.paths.terms);
  await expect(page.locator("html")).toHaveAttribute("lang", spanish.locale);
});

test("keeps the footer unobstructed across themes, viewports, and content lengths", async ({
  page,
}) => {
  test.slow();

  for (const viewport of footerViewports) {
    for (const theme of ["light", "dark"] as const) {
      await test.step(`${viewport.name} ${theme} short content`, async () => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });
        await page.goto("/");
        await expect(page.locator("html")).toHaveClass(
          new RegExp(`(^|\\s)${theme}(\\s|$)`),
        );

        const geometry = await expectNormalFlowGeometry(page);
        expect(
          Math.abs(geometry.footerBottom - geometry.viewportHeight),
        ).toBeLessThanOrEqual(1);
        await expectMinimumTargetHeight(page);
        await expectNoSeriousAxeViolations(page, "footer");
      });

      await test.step(`${viewport.name} ${theme} long content`, async () => {
        await page.goto("/terms");

        const geometry = await expectNormalFlowGeometry(page);
        expect(geometry.footerBottom).toBeGreaterThan(geometry.viewportHeight);
        await expectMinimumTargetHeight(page);
        await expectNoSeriousAxeViolations(page, "footer");
      });

      await test.step(`${viewport.name} ${theme} dynamic content`, async () => {
        await page.goto("/");
        const before = await expectNormalFlowGeometry(page);

        await page.getByRole("main").evaluate((main) => {
          const expander = document.createElement("div");
          expander.dataset.footerDynamicContent = "";
          expander.setAttribute("aria-hidden", "true");
          expander.style.flex = "0 0 auto";
          expander.style.height = `${window.innerHeight}px`;
          main.append(expander);
        });

        const after = await expectNormalFlowGeometry(page);
        expect(after.footerTop).toBeGreaterThan(before.footerTop);
        await expectMinimumTargetHeight(page);
        await expectNoSeriousAxeViolations(page, "footer");
      });
    }
  }
});

test("keeps both localized links usable when their labels wrap", async ({ page }) => {
  await page.setViewportSize(footerViewports[0]);
  await page.goto("/ca");

  const footer = page.getByRole("contentinfo");
  const legalNavigation = footer.getByRole("navigation", {
    name: "Informació legal",
  });
  await legalNavigation.getByRole("listitem").evaluateAll((items) => {
    for (const item of items) item.style.width = "5rem";
  });
  const wrappedTargets = await legalNavigation
    .getByRole("link")
    .evaluateAll((links) =>
      links.map((link) => {
        const range = document.createRange();
        range.selectNodeContents(link);
        return {
          height: link.getBoundingClientRect().height,
          lineCount: range.getClientRects().length,
        };
      }),
    );

  expect(wrappedTargets).toHaveLength(2);
  for (const target of wrappedTargets) {
    expect(target.lineCount).toBeGreaterThan(1);
    expect(target.height).toBeGreaterThanOrEqual(24);
  }
  expect((await getFooterGeometry(page)).hasHorizontalOverflow).toBe(false);
});

test("focuses and activates both legal links in document order", async ({ page }) => {
  await page.goto("/");
  let links = page
    .getByRole("contentinfo")
    .getByRole("navigation", { name: "Legal information" })
    .getByRole("link");

  await tabTo(page, links.nth(0));
  await expectVisibleFocus(links.nth(0));
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/terms");

  await page.goto("/");
  links = page
    .getByRole("contentinfo")
    .getByRole("navigation", { name: "Legal information" })
    .getByRole("link");
  await tabTo(page, links.nth(0));
  await page.keyboard.press("Tab");
  await expect(links.nth(1)).toBeFocused();
  await expectVisibleFocus(links.nth(1));
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/privacy");
});

test("keeps the focused legal link visible in forced-colors mode", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");

  const firstLink = page
    .getByRole("contentinfo")
    .getByRole("navigation", { name: "Legal information" })
    .getByRole("link")
    .first();
  await tabTo(page, firstLink);

  const focusStyle = await firstLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      forcedColorsActive: matchMedia("(forced-colors: active)").matches,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });

  expect(focusStyle.forcedColorsActive).toBe(true);
  expect(focusStyle.outlineStyle).toBe("solid");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);
});