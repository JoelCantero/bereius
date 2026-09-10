import { expect, test, type Locator, type Page } from "@playwright/test";
import { source as axeSource } from "axe-core";
import { Pool } from "pg";

import {
  cleanupAuthenticatedUsers,
  installAuthSessionCookie,
  seedAuthenticatedUser,
} from "./helpers/authenticated-user";

const providerControlUrl = process.env.E2E_PROVIDER_HTTP_URL;

interface CapturedProviderRequest {
  target: string;
  body: string;
}

interface DeletionTarget {
  userId: string;
  normalizedEmail: string;
  addressBucketKey?: string;
  clientBucketKeys?: string[];
}

interface AccountGraphCounts {
  users: number;
  accounts: number;
  sessions: number;
  acceptances: number;
  tokens: number;
  addressBuckets: number;
  clientBuckets: number;
}

const localeTargets = [
  {
    locale: "en",
    path: "/account/data",
    completionPath: "/account-deleted",
    heading: "Data & Privacy",
    trigger: "Delete account",
    cancel: "Cancel",
    continue: "Continue",
    sendLink: "Send fresh link",
    reauthError: "Couldn’t send the link. Try again.",
    dialogTitle: "Permanently delete your account?",
    confirmTitle: "Final confirmation",
    confirm: "Permanently delete account",
    deletionError: "Couldn’t delete the account. Try again.",
    completion: "Account deleted",
    home: "Return home",
    close: "Close dialog",
    invalidLink:
      "This verification link is not valid. Request a new link and try again.",
    sessionConflict:
      "This link cannot be used with the current session. Sign out before trying again.",
  },
  {
    locale: "es",
    path: "/es/account/data",
    completionPath: "/es/account-deleted",
    heading: "Datos y privacidad",
    trigger: "Eliminar cuenta",
    cancel: "Cancelar",
    continue: "Continuar",
    sendLink: "Enviar un enlace nuevo",
    reauthError: "No hemos podido enviar el enlace. Inténtalo de nuevo.",
    dialogTitle: "¿Eliminar tu cuenta permanentemente?",
    confirmTitle: "Confirmación final",
    confirm: "Eliminar la cuenta permanentemente",
    deletionError:
      "No hemos podido eliminar la cuenta. Inténtalo de nuevo.",
    completion: "Cuenta eliminada",
    home: "Volver al inicio",
    close: "Cerrar diálogo",
    invalidLink:
      "Este enlace de verificación no es válido. Solicita uno nuevo y vuelve a intentarlo.",
    sessionConflict:
      "Este enlace no se puede usar con la sesión actual. Ciérrala antes de volver a intentarlo.",
  },
  {
    locale: "ca",
    path: "/ca/account/data",
    completionPath: "/ca/account-deleted",
    heading: "Dades i privacitat",
    trigger: "Elimina el compte",
    cancel: "Cancel·la",
    continue: "Continua",
    sendLink: "Envia un enllaç nou",
    reauthError: "No hem pogut enviar l'enllaç. Torna-ho a provar.",
    dialogTitle: "Vols eliminar el compte permanentment?",
    confirmTitle: "Confirmació final",
    confirm: "Elimina el compte permanentment",
    deletionError:
      "No hem pogut eliminar el compte. Torna-ho a provar.",
    completion: "Compte eliminat",
    home: "Torna a l'inici",
    close: "Tanca el diàleg",
    invalidLink:
      "Aquest enllaç de verificació no és vàlid. Sol·licita'n un de nou i torna-ho a provar.",
    sessionConflict:
      "Aquest enllaç no es pot utilitzar amb la sessió actual. Tanca-la abans de tornar-ho a provar.",
  },
] as const;

function requireProviderControlUrl() {
  if (!providerControlUrl) {
    throw new Error("E2E_PROVIDER_HTTP_URL is required for this journey");
  }
  return providerControlUrl;
}

async function getLatestDeletionVerificationUrl(recipient: string) {
  const capture = (await fetch(
    `${requireProviderControlUrl()}/control/requests`,
  ).then((response) => response.json())) as {
    requests: CapturedProviderRequest[];
  };
  const sendRequest = capture.requests.findLast(
    (request) =>
      request.target.endsWith(".send") && request.body.includes(recipient),
  );
  const verificationUrl = sendRequest?.body.match(
    /https?:\/\/[^\s<"\\]+\/api\/account\/deletion\/verify\?token=[A-Za-z0-9_-]{43}/,
  )?.[0];
  expect(verificationUrl).toBeTruthy();
  return verificationUrl!;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for account deletion E2E tests");
  }
  return new Pool({ connectionString });
}

async function readAccountGraph(target: DeletionTarget): Promise<AccountGraphCounts> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM "User" WHERE "id" = $1) AS "users",
        (SELECT COUNT(*)::int FROM "Account" WHERE "userId" = $1) AS "accounts",
        (SELECT COUNT(*)::int FROM "Session" WHERE "userId" = $1) AS "sessions",
        (SELECT COUNT(*)::int FROM "PolicyAcceptance" WHERE "userId" = $1) AS "acceptances",
        (SELECT COUNT(*)::int FROM "VerificationToken" WHERE "identifier" = $2) AS "tokens",
        (SELECT COUNT(*)::int FROM "RateLimitBucket" WHERE "key" = $3) AS "addressBuckets",
        (SELECT COUNT(*)::int FROM "RateLimitBucket" WHERE "key" = ANY($4::text[])) AS "clientBuckets"`,
      [
        target.userId,
        target.normalizedEmail,
        target.addressBucketKey ?? "",
        target.clientBucketKeys ?? [],
      ],
    );
    const row = result.rows[0] as Record<keyof AccountGraphCounts, number | string>;
    return {
      users: Number(row.users),
      accounts: Number(row.accounts),
      sessions: Number(row.sessions),
      acceptances: Number(row.acceptances),
      tokens: Number(row.tokens),
      addressBuckets: Number(row.addressBuckets),
      clientBuckets: Number(row.clientBuckets),
    };
  } finally {
    await pool.end();
  }
}

async function installUserDeletionFailure(userId: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(userId)) throw new Error("invalid fixture user id");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const functionName = `e2e_delete_fail_${suffix}`;
  const triggerName = `e2e_delete_trigger_${suffix}`;
  const pool = getPool();
  try {
    await pool.query(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected account deletion failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER "${triggerName}"
      BEFORE DELETE ON "User"
      FOR EACH ROW WHEN (OLD."id" = '${userId}')
      EXECUTE FUNCTION "${functionName}"()
    `);
  } finally {
    await pool.end();
  }

  return async () => {
    const cleanupPool = getPool();
    try {
      await cleanupPool.query(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON "User"`,
      );
      await cleanupPool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    } finally {
      await cleanupPool.end();
    }
  };
}

async function setSessionAuthenticatedAt(
  sessionToken: string,
  authenticatedAt: Date | null,
) {
  const pool = getPool();
  try {
    await pool.query(
      `UPDATE "Session" SET "authenticatedAt" = $2 WHERE "sessionToken" = $1`,
      [
        sessionToken,
        authenticatedAt
          ?.toISOString()
          .replace("T", " ")
          .replace("Z", "") ?? null,
      ],
    );
  } finally {
    await pool.end();
  }
}

async function revokeSession(sessionToken: string) {
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM "Session" WHERE "sessionToken" = $1`,
      [sessionToken],
    );
  } finally {
    await pool.end();
  }
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function expectNoSeriousAxeViolations(page: Page) {
  await expectStableDialog(page);
  await page.evaluate(axeSource);
  const results: {
    violations: Array<{
      id: string;
      nodes: Array<{ impact?: string | null }>;
    }>;
  } = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    return axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
  });
  const seriousOrCritical = results.violations.filter((violation) =>
    violation.nodes.some((node) =>
      ["serious", "critical"].includes(node.impact ?? ""),
    ),
  );
  expect(seriousOrCritical).toEqual([]);
}

async function expectStableDialog(page: Page) {
  const openDialog = page.locator('[data-slot="dialog-content"][data-open]');
  if ((await openDialog.count()) > 0) {
    await expect(openDialog).toHaveCSS("opacity", "1");
  }
}

async function expectResponsiveState(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        const controls = [
          ...document.querySelectorAll<HTMLElement>(
            "main button, main a, [role=dialog] button, [role=dialog] a",
          ),
        ].filter(
          (element) =>
            element.getClientRects().length > 0 &&
            !element.closest(
              '[aria-hidden="true"], [data-base-ui-inert], [inert]',
            ),
        );
        const rectangles = controls.map((element) =>
          element.getBoundingClientRect(),
        );
        const outOfBounds = controls.filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -0.5 || rect.right > window.innerWidth + 0.5;
        }).length;
        const clipped = controls.filter(
          (element) =>
            element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1,
        ).length;
        let overlaps = 0;
        for (let left = 0; left < rectangles.length; left += 1) {
          for (let right = left + 1; right < rectangles.length; right += 1) {
            const first = rectangles[left]!;
            const second = rectangles[right]!;
            if (
              Math.min(first.right, second.right) -
                  Math.max(first.left, second.left) >
                1 &&
              Math.min(first.bottom, second.bottom) -
                  Math.max(first.top, second.top) >
                1
            ) {
              overlaps += 1;
            }
          }
        }
        return {
          horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
          outOfBounds,
          clipped,
          overlaps,
        };
      }),
    )
    .toEqual({
      horizontalOverflow: false,
      outOfBounds: 0,
      clipped: 0,
      overlaps: 0,
    });
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  await cleanupAuthenticatedUsers();
});

test("keeps localized Data & Privacy protected", async ({ page, baseURL }) => {
  for (const [path, expected] of [
    ["/account/data", "/login?callbackUrl=%2Faccount%2Fdata"],
    ["/es/account/data", "/es/login?callbackUrl=%2Fes%2Faccount%2Fdata"],
    ["/ca/account/data", "/ca/login?callbackUrl=%2Fca%2Faccount%2Fdata"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  }

  for (const target of localeTargets) {
    await page.context().addCookies([
      {
        name: "NEXT_LOCALE",
        value: target.locale,
        url: new URL(baseURL ?? "http://127.0.0.1:3100").origin,
        sameSite: "Lax",
      },
    ]);
    await page.goto(target.completionPath);
    await expect(page.locator("html")).toHaveAttribute("lang", target.locale);
    await expect(
      page.getByRole("heading", { name: target.completion }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: target.home })).toBeVisible();
  }
});

test("reviews, separately confirms, deletes all sessions, and clears local auth", async ({
  browser,
  context,
  page,
  baseURL,
}) => {
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const seeded = await seedAuthenticatedUser({
    additionalSessionCount: 1,
    withDeletionGraph: true,
  });
  await expect(readAccountGraph(seeded)).resolves.toEqual({
    users: 1,
    accounts: 1,
    sessions: 2,
    acceptances: 1,
    tokens: 3,
    addressBuckets: 1,
    clientBuckets: 2,
  });
  await installAuthSessionCookie(context, seeded.sessionTokens[0]!, appUrl);
  const otherContext = await browser.newContext();
  await installAuthSessionCookie(otherContext, seeded.sessionTokens[1]!, appUrl);
  const otherPage = await otherContext.newPage();

  await page.goto("/account/data");
  await expect(page.getByRole("heading", { name: "Data & Privacy" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Data & Privacy" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const trigger = page.getByRole("button", { name: "Delete account" });
  await trigger.click();
  await expect(page.getByText("This action is permanent and cannot be undone.")).toBeVisible();
  await expect(page.getByText(/every other device/)).toBeVisible();
  await expect(page.getByText(/sign-in and signup links/)).toBeVisible();
  await expect(page.getByText(/profile, identities, sessions, and policy acceptances/)).toBeVisible();
  await expect(page.getByText(/no longer be able to access/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Permanently delete account" })).toBeVisible();
  await page.getByRole("button", { name: "Permanently delete account" }).click();
  await expect(page).toHaveURL(`${appUrl}/account-deleted`);
  const completionHeading = page.getByRole("heading", { name: "Account deleted" });
  await expect(completionHeading).toBeVisible();
  await expect(completionHeading).toBeFocused();
  expect(
    (await context.cookies()).filter((cookie) =>
      ["next-auth.session-token", "__Secure-next-auth.session-token"].includes(
        cookie.name,
      ),
    ),
  ).toEqual([]);
  await expect(readAccountGraph(seeded)).resolves.toEqual({
    users: 0,
    accounts: 0,
    sessions: 0,
    acceptances: 0,
    tokens: 0,
    addressBuckets: 0,
    clientBuckets: 2,
  });
  const publicText = await page.locator("body").innerText();
  expect(publicText).not.toContain(seeded.email);
  expect(publicText).not.toContain(seeded.userId);

  await otherPage.goto("/account");
  await expect(otherPage).toHaveURL(/\/login\?callbackUrl=%2Faccount$/);
  await otherContext.close();
});

test("follows localized sign-in when the session is lost before final confirmation", async ({
  context,
  page,
  baseURL,
}) => {
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const seeded = await seedAuthenticatedUser({ withDeletionGraph: true });
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);

  await page.goto("/es/account/data");
  await page.getByRole("button", { name: "Eliminar cuenta" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(
    page.getByRole("button", { name: "Eliminar la cuenta permanentemente" }),
  ).toBeVisible();

  await revokeSession(seeded.sessionToken);
  await page
    .getByRole("button", { name: "Eliminar la cuenta permanentemente" })
    .click();

  await expect(page).toHaveURL(
    `${appUrl}/es/login?callbackUrl=%2Fes%2Faccount%2Fdata`,
  );
  expect(
    await page.evaluate(() =>
      window.sessionStorage.getItem("account-deletion-pending"),
    ),
  ).toBeNull();
  await expect(readAccountGraph(seeded)).resolves.toEqual({
    users: 1,
    accounts: 1,
    sessions: 0,
    acceptances: 1,
    tokens: 3,
    addressBuckets: 1,
    clientBuckets: 2,
  });
});

test("cancels by button, Escape, and close without changing the account", async ({
  context,
  page,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser({
    additionalSessionCount: 1,
    withDeletionGraph: true,
  });
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);
  const before = await readAccountGraph(seeded);
  let mutationRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/api/account/deletion")
    ) {
      mutationRequests += 1;
    }
  });

  await page.goto("/account/data");
  const trigger = page.getByRole("button", { name: "Delete account" });
  for (const method of ["cancel", "escape", "close"] as const) {
    await trigger.click();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    if (method === "cancel") {
      await page.getByRole("button", { name: "Cancel" }).click();
    } else if (method === "escape") {
      await page.keyboard.press("Escape");
    } else {
      await page.getByRole("button", { name: "Close dialog" }).click();
    }
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(readAccountGraph(seeded)).resolves.toEqual(before);
  }
  expect(mutationRequests).toBe(0);
});

test("announces a delivery failure and retries in place without changing the account", async ({
  context,
  page,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser({
    authenticatedAt: new Date(Date.now() - 11 * 60_000),
  });
  await installAuthSessionCookie(
    context,
    seeded.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  let attempts = 0;
  await page.route("**/api/account/deletion/reauthenticate", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ status: "unavailable", internal: "hidden" }),
      });
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ status: "sent" }),
    });
  });

  await page.goto("/es/account/data");
  await page.getByRole("button", { name: "Eliminar cuenta" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Enviar un enlace nuevo" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText(
    "No hemos podido enviar el enlace. Inténtalo de nuevo.",
  );
  await expect(alert).toBeFocused();
  await expect(page.getByText("hidden")).toHaveCount(0);
  await page.getByRole("button", { name: "Enviar un enlace nuevo" }).click();
  await expect(page.getByText("Revisa tu correo antes de continuar.")).toBeVisible();
  expect(attempts).toBe(2);
  await expect(readAccountGraph(seeded)).resolves.toMatchObject({
    users: 1,
    sessions: 1,
  });
});

test("rolls back a database failure, restores controls, and deletes on retry", async ({
  context,
  page,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser({
    additionalSessionCount: 1,
    withDeletionGraph: true,
  });
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);
  const before = await readAccountGraph(seeded);
  const removeFailure = await installUserDeletionFailure(seeded.userId);

  try {
    await page.goto("/account/data");
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Permanently delete account" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText("Couldn’t delete the account. Try again.");
    await expect(alert).toBeFocused();
    await expect(readAccountGraph(seeded)).resolves.toEqual(before);
  } finally {
    await removeFailure();
  }

  await page.getByRole("button", { name: "Permanently delete account" }).click();
  await expect(page).toHaveURL(`${appUrl}/account-deleted`);
  await expect(readAccountGraph(seeded)).resolves.toMatchObject({
    users: 0,
    accounts: 0,
    sessions: 0,
    acceptances: 0,
    tokens: 0,
    addressBuckets: 0,
  });
});

test("blocks dismissal and duplicate controls while final deletion is pending", async ({
  context,
  page,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser();
  await installAuthSessionCookie(
    context,
    seeded.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let deletionPosts = 0;
  await page.route("**/api/account/deletion", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    deletionPosts += 1;
    await requestGate;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: "deletion_failed" }),
    });
  });

  await page.goto("/account/data");
  await page.getByRole("button", { name: "Delete account" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Permanently delete account" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status")).toHaveText("Deleting account…");
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close dialog" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Permanently delete account" }),
  ).toHaveCount(0);
  await expect.poll(() => deletionPosts).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(deletionPosts).toBe(1);

  releaseRequest();
  await expect(page.getByRole("alert")).toBeFocused();
  expect(deletionPosts).toBe(1);
  await expect(readAccountGraph(seeded)).resolves.toMatchObject({
    users: 1,
    sessions: 1,
  });
});

test("rejects a foreign host before account deletion work", async ({
  request,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser({
    additionalSessionCount: 1,
    withDeletionGraph: true,
  });
  const before = await readAccountGraph(seeded);
  const response = await request.post(
    `${baseURL ?? "http://127.0.0.1:3100"}/api/account/deletion`,
    {
      headers: {
        host: "foreign.example.test",
        origin: "https://foreign.example.test",
      },
      data: {
        csrfToken: "forged",
        locale: "en",
        confirmation: "permanently_delete",
        email: seeded.email,
      },
    },
  );

  expect(response.status()).toBe(421);
  const responseText = await response.text();
  expect(responseText).not.toContain(seeded.email);
  expect(responseText).not.toContain(seeded.userId);
  await expect(readAccountGraph(seeded)).resolves.toEqual(before);
});

test("enforces generic address and operation-specific client limits", async ({
  context,
  page,
  baseURL,
}) => {
  test.skip(!providerControlUrl, "controlled HTTP provider fixture is required");
  const seeded = await seedAuthenticatedUser({
    authenticatedAt: new Date(Date.now() - 11 * 60_000),
  });
  await installAuthSessionCookie(
    context,
    seeded.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  await page.goto("/account/data");

  const outcomes = await page.evaluate(async () => {
    const csrfResponse = await fetch("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const csrfPayload = (await csrfResponse.json()) as { csrfToken: string };
    const issueResults = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch("/api/account/deletion/reauthenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csrfToken: csrfPayload.csrfToken, locale: "en" }),
      });
      issueResults.push({
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: await response.json(),
      });
    }

    const deletionResults = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch("/api/account/deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      deletionResults.push({
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: await response.json(),
      });
    }
    return { issueResults, deletionResults };
  });

  expect(outcomes.issueResults.map(({ status }) => status)).toEqual([
    202, 202, 202, 429, 429, 429,
  ]);
  expect(outcomes.deletionResults.map(({ status }) => status)).toEqual([
    400, 400, 400, 400, 400, 429,
  ]);
  for (const outcome of [
    ...outcomes.issueResults.slice(3),
    outcomes.deletionResults.at(-1)!,
  ]) {
    expect(outcome.retryAfter).toBe(String(outcome.body.retryAfter));
    expect(Object.keys(outcome.body).sort()).toEqual(["retryAfter", "status"]);
    expect(outcome.body.status).toBe("rate_limited");
    expect(JSON.stringify(outcome.body)).not.toContain(seeded.email);
    expect(JSON.stringify(outcome.body)).not.toContain(seeded.userId);
  }
  const capture = (await fetch(
    `${requireProviderControlUrl()}/control/requests`,
  ).then((response) => response.json())) as {
    requests: CapturedProviderRequest[];
  };
  expect(
    capture.requests.filter(
      (request) =>
        request.target.endsWith(".send") &&
        request.body.includes(seeded.email),
    ),
  ).toHaveLength(3);
  await expect(readAccountGraph(seeded)).resolves.toMatchObject({
    users: 1,
    sessions: 1,
    tokens: 1,
  });
});

test("preserves both accounts on identity conflict and rejects a consumed link", async ({
  browser,
  context,
  page,
  baseURL,
}) => {
  test.skip(!providerControlUrl, "controlled HTTP provider fixture is required");
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const owner = await seedAuthenticatedUser({
    authenticatedAt: new Date(Date.now() - 11 * 60_000),
  });
  const conflicting = await seedAuthenticatedUser();
  await installAuthSessionCookie(context, owner.sessionToken, appUrl);

  await page.goto("/es/account/data");
  await page.getByRole("button", { name: "Eliminar cuenta" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Enviar un enlace nuevo" }).click();
  await expect(page.getByText("Revisa tu correo antes de continuar.")).toBeVisible();
  const verificationUrl = await getLatestDeletionVerificationUrl(owner.email);
  await expect(readAccountGraph(owner)).resolves.toMatchObject({ tokens: 1 });

  const conflictContext = await browser.newContext();
  await installAuthSessionCookie(conflictContext, conflicting.sessionToken, appUrl);
  const conflictPage = await conflictContext.newPage();
  await conflictPage.goto(verificationUrl);
  await expect(conflictPage).toHaveURL(
    `${appUrl}/es/account/data?state=session_conflict`,
  );
  await expect(conflictPage.getByRole("main").getByRole("alert")).toHaveText(
    localeTargets[1].sessionConflict,
  );
  const conflictText = await conflictPage.locator("body").innerText();
  expect(conflictText).not.toContain(owner.email);
  expect(conflictText).not.toContain(owner.userId);
  await expect(readAccountGraph(owner)).resolves.toMatchObject({
    users: 1,
    sessions: 1,
    tokens: 1,
  });
  await expect(readAccountGraph(conflicting)).resolves.toMatchObject({
    users: 1,
    sessions: 1,
  });

  const consumerContext = await browser.newContext();
  const consumerPage = await consumerContext.newPage();
  await consumerPage.goto(verificationUrl);
  await expect(consumerPage).toHaveURL(`${appUrl}/es/account/data?intent=delete`);
  await expect(consumerPage.getByRole("dialog")).toBeVisible();
  await expect(readAccountGraph(owner)).resolves.toMatchObject({
    users: 1,
    sessions: 2,
    tokens: 0,
  });

  await consumerPage.goto(verificationUrl);
  await expect(consumerPage).toHaveURL(
    /\/(?:es\/)?account\/data\?state=invalid_link$/,
  );
  await expect(consumerPage.getByRole("main").getByRole("alert")).toHaveText(
    new RegExp(
      `${localeTargets[0].invalidLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${localeTargets[1].invalidLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
  // Scoped to the page, not the document: consuming the link signed this
  // context in as the owner, so the console navigation shows the owner's own
  // address. What must stay silent is the rejection itself.
  const replayText = await consumerPage.getByRole("main").innerText();
  expect(replayText).not.toContain(owner.email);
  expect(replayText).not.toContain(owner.userId);
  await expect(readAccountGraph(owner)).resolves.toMatchObject({
    users: 1,
    sessions: 2,
    tokens: 0,
  });

  await conflictContext.close();
  await consumerContext.close();
});

test("fresh authentication can continue on another device without deleting automatically", async ({
  browser,
  context,
  page,
  baseURL,
}) => {
  test.skip(!providerControlUrl, "controlled HTTP provider fixture is required");
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const seeded = await seedAuthenticatedUser({
    authenticatedAt: new Date(Date.now() - 11 * 60_000),
  });
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);

  await page.goto("/es/account/data");
  await page.getByRole("button", { name: "Eliminar cuenta" }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Enviar un enlace nuevo" }).click();
  await expect(page.getByText("Revisa tu correo antes de continuar.")).toBeVisible();

  const verificationUrl = await getLatestDeletionVerificationUrl(seeded.email);

  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  await freshPage.goto(verificationUrl);
  await expect(freshPage).toHaveURL(`${appUrl}/es/account/data?intent=delete`);
  await expect(freshPage.getByRole("dialog")).toBeVisible();
  await expect(
    freshPage.getByRole("button", { name: "Eliminar la cuenta permanentemente" }),
  ).toHaveCount(0);
  await freshPage.getByRole("button", { name: "Continuar" }).click();
  await expect(
    freshPage.getByRole("button", { name: "Eliminar la cuenta permanentemente" }),
  ).toBeVisible();
  await freshContext.close();
});

test("recovers a committed deletion after the response is lost without another POST", async ({
  context,
  page,
  baseURL,
}) => {
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const seeded = await seedAuthenticatedUser();
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);
  let deletionPosts = 0;
  await page.route("**/api/account/deletion", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    deletionPosts += 1;
    await route.fetch();
    await route.abort("failed");
  });

  await page.goto("/account/data");
  await page.getByRole("button", { name: "Delete account" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Permanently delete account" }).click();
  await expect(page.getByText("Checking whether deletion completed…")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect(page).toHaveURL(`${appUrl}/account-deleted`);
  expect(deletionPosts).toBe(1);
});

test("does not report success when a lost request did not commit", async ({
  context,
  page,
  baseURL,
}) => {
  const seeded = await seedAuthenticatedUser({ withDeletionGraph: true });
  const before = await readAccountGraph(seeded);
  await installAuthSessionCookie(
    context,
    seeded.sessionToken,
    baseURL ?? "http://127.0.0.1:3100",
  );
  let deletionPosts = 0;
  await page.route("**/api/account/deletion", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    deletionPosts += 1;
    await route.abort("failed");
  });

  await page.goto("/account/data");
  await page.getByRole("button", { name: "Delete account" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Permanently delete account" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Checking whether deletion completed…",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await expect(page.getByRole("alert")).toHaveText(
    "Couldn’t delete the account. Try again.",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  expect(deletionPosts).toBe(1);
  expect(
    await page.evaluate(() =>
      window.sessionStorage.getItem("account-deletion-pending"),
    ),
  ).toBeNull();
  await expect(readAccountGraph(seeded)).resolves.toEqual(before);
});

test("exposes complete accessible states in every locale", async ({
  context,
  page,
  baseURL,
}) => {
  test.slow();
  const seeded = await seedAuthenticatedUser({
    email: `long-localized-deletion-address-${crypto.randomUUID()}@subdomain.example.test`,
  });
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);
  await page.route("**/api/account/deletion/reauthenticate", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ status: "unavailable", internal: "private" }),
    });
  });
  await page.route("**/api/account/deletion", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ status: "deletion_failed", internal: "private" }),
    });
  });

  for (const target of localeTargets) {
    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: target.locale,
        url: new URL(appUrl).origin,
        sameSite: "Lax",
      },
    ]);
    await setSessionAuthenticatedAt(
      seeded.sessionToken,
      new Date(Date.now() - 11 * 60_000),
    );
    await page.goto(target.path);
    await expect(page.locator("html")).toHaveAttribute("lang", target.locale);
    await expect(page).toHaveTitle(new RegExp(target.heading));
    await expect(
      page.getByRole("link", { name: target.heading }),
    ).toHaveAttribute("aria-current", "page");
    await expectResponsiveState(page);
    await expectNoSeriousAxeViolations(page);

    const trigger = page.getByRole("button", { name: target.trigger });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: target.dialogTitle }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: target.cancel })).toBeFocused();
    for (let press = 0; press < 5; press += 1) {
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          dialog.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        )
        .toBe(true);
    }
    await expectResponsiveState(page);
    await expectNoSeriousAxeViolations(page);

    await page.getByRole("button", { name: target.continue }).click();
    await page.getByRole("button", { name: target.sendLink }).click();
    await expect(page.getByRole("alert")).toHaveText(target.reauthError);
    await expect(page.getByRole("alert")).toBeFocused();
    expect(await dialog.innerText()).not.toContain("private");
    expect(await dialog.innerText()).not.toContain(seeded.email);
    await expectResponsiveState(page);
    await expectNoSeriousAxeViolations(page);
    await page.getByRole("button", { name: target.cancel }).click();
    await expect(trigger).toBeFocused();

    await setSessionAuthenticatedAt(seeded.sessionToken, new Date());
    await page.reload();
    await page.getByRole("button", { name: target.trigger }).click();
    await page.getByRole("button", { name: target.continue }).click();
    await expect(
      page.getByRole("heading", { name: target.confirmTitle }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: target.confirm }),
    ).toBeVisible();
    await expectResponsiveState(page);
    await expectNoSeriousAxeViolations(page);
    await page.getByRole("button", { name: target.confirm }).click();
    await expect(page.getByRole("alert")).toHaveText(target.deletionError);
    await expect(page.getByRole("alert")).toBeFocused();
    expect(await page.getByRole("dialog").innerText()).not.toContain("private");
    await expectResponsiveState(page);
    await expectNoSeriousAxeViolations(page);

    await page.goto(target.completionPath);
    const completionHeading = page.getByRole("heading", {
      name: target.completion,
    });
    await expect(completionHeading).toBeFocused();
    await expect(page.getByRole("link", { name: target.home })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(seeded.email);
    await expectResponsiveState(page);
    await expectNoSeriousAxeViolations(page);
  }

  await expect(readAccountGraph(seeded)).resolves.toMatchObject({
    users: 1,
    sessions: 1,
  });
});

test("keeps every locale stable in light and dark desktop themes", async ({
  context,
  page,
  baseURL,
}, testInfo) => {
  test.slow();
  const seeded = await seedAuthenticatedUser();
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const target of localeTargets) {
      await context.addCookies([
        {
          name: "NEXT_LOCALE",
          value: target.locale,
          url: new URL(appUrl).origin,
          sameSite: "Lax",
        },
      ]);
      await setSessionAuthenticatedAt(seeded.sessionToken, new Date());
      await page.goto(target.path);
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`(^|\\s)${theme}(\\s|$)`),
      );
      await expect(
        page.getByRole("heading", { name: target.heading }),
      ).toBeVisible();
      await expectResponsiveState(page);
      await page.getByRole("button", { name: target.trigger }).click();
      await page.getByRole("button", { name: target.continue }).click();
      await expect(
        page.getByRole("button", { name: target.confirm }),
      ).toBeVisible();
      await expectResponsiveState(page);
      await expectStableDialog(page);
      await page.screenshot({
        path: testInfo.outputPath(
          `account-deletion-${target.locale}-${theme}-desktop.png`,
        ),
        fullPage: true,
      });
      await page.getByRole("button", { name: target.cancel }).click();
      await page.goto(target.completionPath);
      await expect(
        page.getByRole("heading", { name: target.completion }),
      ).toBeVisible();
      await expectResponsiveState(page);
    }
  }
});

test(
  "keeps every locale stable in light and dark at 320x900",
  { tag: "@mobile" },
  async ({ context, page, baseURL }, testInfo) => {
    test.slow();
    const seeded = await seedAuthenticatedUser();
    const appUrl = baseURL ?? "http://127.0.0.1:3100";
    await installAuthSessionCookie(context, seeded.sessionToken, appUrl);

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const target of localeTargets) {
        await context.addCookies([
          {
            name: "NEXT_LOCALE",
            value: target.locale,
            url: new URL(appUrl).origin,
            sameSite: "Lax",
          },
        ]);
        await setSessionAuthenticatedAt(seeded.sessionToken, new Date());
        await page.goto(target.path);
        await expect(page.locator("html")).toHaveClass(
          new RegExp(`(^|\\s)${theme}(\\s|$)`),
        );
        await expectResponsiveState(page);
        await page.getByRole("button", { name: target.trigger }).click();
        await expect(
          page.getByRole("button", { name: target.cancel }),
        ).toBeFocused();
        await expectResponsiveState(page);
        await page.getByRole("button", { name: target.continue }).click();
        await expect(
          page.getByRole("button", { name: target.confirm }),
        ).toBeVisible();
        await expectResponsiveState(page);
        await expectStableDialog(page);
        await page.screenshot({
          path: testInfo.outputPath(
            `account-deletion-${target.locale}-${theme}-mobile.png`,
          ),
          fullPage: true,
        });
        await page.getByRole("button", { name: target.cancel }).click();
        await page.goto(target.completionPath);
        await expect(
          page.getByRole("heading", { name: target.completion }),
        ).toBeVisible();
        await expectResponsiveState(page);
      }
    }
  },
);

test("supports reduced motion and a keyboard-only failure retry through completion", async ({
  context,
  page,
  baseURL,
}) => {
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const seeded = await seedAuthenticatedUser({ withDeletionGraph: true });
  await installAuthSessionCookie(context, seeded.sessionToken, appUrl);
  await page.emulateMedia({ reducedMotion: "reduce" });
  let deletionPosts = 0;
  await page.route("**/api/account/deletion", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    deletionPosts += 1;
    if (deletionPosts === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          status: "deletion_failed",
          internal: "must not render",
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/ca/account/data");
  const trigger = page.getByRole("button", { name: localeTargets[2].trigger });
  await tabTo(page, trigger);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(
    page.getByRole("button", { name: localeTargets[2].cancel }),
  ).toBeFocused();
  const reducedTransitions = await page
    .locator('[data-slot="dialog-backdrop"], [data-slot="dialog-content"]')
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).transitionProperty),
    );
  expect(reducedTransitions).toEqual(["none", "none"]);
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
  }

  const continueButton = page.getByRole("button", {
    name: localeTargets[2].continue,
  });
  await tabTo(page, continueButton);
  await page.keyboard.press("Enter");
  const confirmButton = page.getByRole("button", {
    name: localeTargets[2].confirm,
  });
  await tabTo(page, confirmButton);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    localeTargets[2].deletionError,
  );
  await expect(page.getByRole("alert")).toBeFocused();
  expect(await dialog.innerText()).not.toContain("must not render");
  expect(
    await page.evaluate(() =>
      window.sessionStorage.getItem("account-deletion-pending"),
    ),
  ).toBeNull();

  await tabTo(page, confirmButton);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${appUrl}/ca/account-deleted`);
  await expect(
    page.getByRole("heading", { name: localeTargets[2].completion }),
  ).toBeFocused();
  expect(deletionPosts).toBe(2);
  await expect(readAccountGraph(seeded)).resolves.toMatchObject({
    users: 0,
    accounts: 0,
    sessions: 0,
    acceptances: 0,
    tokens: 0,
    addressBuckets: 0,
  });
});