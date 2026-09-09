import { createHash, randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  cleanupAuthenticatedUsers,
  installAuthSessionCookie,
  seedAuthenticatedUser,
} from "./helpers/authenticated-user";

const providerControlUrl = process.env.E2E_PROVIDER_HTTP_URL;
const provider = process.env.E2E_MAIL_PROVIDER ?? "brevo";
const providerTarget = `${provider}.send`;
const providerApiKey = process.env.E2E_MAIL_API_KEY ?? "e2e-provider-key";
const providerApiSecret =
  process.env.E2E_MAIL_API_SECRET ?? "e2e-provider-secret";
const createdSignupEmails = new Set<string>();
const createdClientIdentifiers = new Set<string>();

interface CapturedProviderRequest {
  target: string;
  logicalUrl: string;
  method: string;
  headers: Record<string, string | string[]>;
  body: string;
}

interface NormalizedProviderMessage {
  recipient: string;
  sender: { email: string; name: string };
  subject: string;
  text: string;
  html: string;
}

function requireProviderControlUrl() {
  if (!providerControlUrl) {
    throw new Error("E2E_PROVIDER_HTTP_URL is required for this release test");
  }
  return providerControlUrl;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for this release test");
  }
  return new Pool({ connectionString });
}

async function cleanupSignupFixtures() {
  if (createdSignupEmails.size === 0 && createdClientIdentifiers.size === 0) {
    return;
  }
  const emails = [...createdSignupEmails];
  const limiterKeys = [
    ...emails.map(
      (email) =>
        `auth:email:address:${createHash("sha256").update(email).digest("hex")}`,
    ),
    ...[...createdClientIdentifiers].map(
      (identifier) => `auth:email:client:${identifier}`,
    ),
  ];
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM "VerificationToken" WHERE "identifier" = ANY($1::text[])`,
      [emails],
    );
    await pool.query(
      `DELETE FROM "User" WHERE "normalizedEmail" = ANY($1::text[])`,
      [emails],
    );
    await pool.query(
      `DELETE FROM "RateLimitBucket" WHERE "key" = ANY($1::text[])`,
      [limiterKeys],
    );
  } finally {
    createdSignupEmails.clear();
    createdClientIdentifiers.clear();
    await pool.end();
  }
}

async function getProviderRequests() {
  const response = await fetch(
    `${requireProviderControlUrl()}/control/requests`,
  );
  if (!response.ok) throw new Error("provider captures were unavailable");
  return (await response.json()) as { requests: CapturedProviderRequest[] };
}

async function expectOneProviderRequest(recipient: string) {
  await expect
    .poll(async () => {
      const { requests } = await getProviderRequests();
      return requests.filter(
        (request) =>
          request.target === providerTarget && request.body.includes(recipient),
      ).length;
    })
    .toBe(1);
}

async function withAuthenticatedPage(
  browser: Browser,
  baseUrl: string,
  sessionToken: string,
  action: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext();
  try {
    await installAuthSessionCookie(context, sessionToken, baseUrl);
    await action(await context.newPage());
  } finally {
    await context.close();
  }
}

function normalizeProviderRequest(
  request: CapturedProviderRequest,
): NormalizedProviderMessage {
  const body = JSON.parse(request.body) as Record<string, unknown>;

  if (provider === "brevo") {
    expect(Object.keys(body).sort()).toEqual([
      "htmlContent",
      "replyTo",
      "sender",
      "subject",
      "textContent",
      "to",
    ]);
    const sender = body.sender as Record<string, string>;
    const recipients = body.to as Array<Record<string, string>>;
    expect(Object.keys(sender).sort()).toEqual(["email", "name"]);
    expect(recipients).toHaveLength(1);
    expect(Object.keys(recipients[0]!).sort()).toEqual(["email"]);
    return {
      recipient: recipients[0]!.email!,
      sender: { email: sender.email!, name: sender.name! },
      subject: body.subject as string,
      text: body.textContent as string,
      html: body.htmlContent as string,
    };
  }

  expect(Object.keys(body)).toEqual(["Messages"]);
  const messages = body.Messages as Array<Record<string, unknown>>;
  expect(messages).toHaveLength(1);
  const message = messages[0]!;
  expect(Object.keys(message).sort()).toEqual([
    "From",
    "HTMLPart",
    "ReplyTo",
    "Subject",
    "TextPart",
    "To",
  ]);
  const sender = message.From as Record<string, string>;
  const recipients = message.To as Array<Record<string, string>>;
  expect(Object.keys(sender).sort()).toEqual(["Email", "Name"]);
  expect(recipients).toHaveLength(1);
  expect(Object.keys(recipients[0]!).sort()).toEqual(["Email"]);
  return {
    recipient: recipients[0]!.Email!,
    sender: { email: sender.Email!, name: sender.Name! },
    subject: message.Subject as string,
    text: message.TextPart as string,
    html: message.HTMLPart as string,
  };
}

test.afterEach(async () => {
  await cleanupSignupFixtures();
  await cleanupAuthenticatedUsers();
});

test("submits all six operational events from the standalone artifact with exact provider contracts", async ({
  browser,
  page,
  baseURL,
}) => {
  test.skip(!providerControlUrl, "controlled HTTP provider fixture is required");
  test.skip(
    provider !== "brevo" && provider !== "mailjet",
    "E2E_MAIL_PROVIDER must be brevo or mailjet",
  );
  const appUrl = baseURL ?? "http://127.0.0.1:3100";
  const loginUser = await seedAuthenticatedUser();
  const existingSignupUser = await seedAuthenticatedUser();
  const deletionUser = await seedAuthenticatedUser({
    authenticatedAt: new Date(Date.now() - 11 * 60_000),
  });
  const securityUser = await seedAuthenticatedUser({
    additionalSessionCount: 1,
    authenticatedAt: new Date(Date.now() - 11 * 60_000),
  });
  const exportUser = await seedAuthenticatedUser();
  const newSignupEmail = `release-signup-${randomUUID()}@example.test`;
  const clientAddressSeed = randomUUID().replaceAll("-", "");
  const clientIdentifier = `2001:db8:${clientAddressSeed.slice(0, 4)}:${clientAddressSeed.slice(4, 8)}::1`;
  createdSignupEmails.add(newSignupEmail);
  createdClientIdentifiers.add(clientIdentifier);
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": clientIdentifier });

  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(loginUser.email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  await expectOneProviderRequest(loginUser.email);

  async function submitSignup(name: string, email: string) {
    await page.goto("/signup");
    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Check your email for the next step",
    );
    await expectOneProviderRequest(email);
  }

  await submitSignup("Release Signup", newSignupEmail);
  await submitSignup("Existing Release User", existingSignupUser.email);

  await withAuthenticatedPage(
    browser,
    appUrl,
    deletionUser.sessionToken,
    async (authenticatedPage) => {
      await authenticatedPage.goto("/account/data");
      await authenticatedPage
        .getByRole("button", { name: "Delete account" })
        .click();
      await authenticatedPage.getByRole("button", { name: "Continue" }).click();
      await authenticatedPage
        .getByRole("button", { name: "Send fresh link" })
        .click();
      await expectOneProviderRequest(deletionUser.email);
    },
  );

  await withAuthenticatedPage(
    browser,
    appUrl,
    securityUser.sessionToken,
    async (authenticatedPage) => {
      await authenticatedPage.goto("/account/security");
      const rows = authenticatedPage
        .getByRole("list", { name: "Active account sessions" })
        .getByRole("listitem");
      await rows.nth(1).getByRole("button", { name: "Revoke session" }).click();
      await authenticatedPage
        .getByRole("dialog", { name: "Revoke session 2?" })
        .getByRole("button", { name: "Revoke session" })
        .click();
      await authenticatedPage
        .getByRole("dialog", { name: "Authenticate again to continue" })
        .getByRole("button", { name: "Send fresh link" })
        .click();
      await expectOneProviderRequest(securityUser.email);
    },
  );

  await withAuthenticatedPage(
    browser,
    appUrl,
    exportUser.sessionToken,
    async (authenticatedPage) => {
      await authenticatedPage.goto("/account/data");
      await authenticatedPage
        .getByRole("button", { name: "Request data export" })
        .click();
      await expectOneProviderRequest(exportUser.email);
    },
  );

  const expectedDestination = new Map([
    [loginUser.email, "/api/auth/callback/email?"],
    [newSignupEmail, "/api/signup/activate?token="],
    [existingSignupUser.email, "/login"],
    [deletionUser.email, "/api/account/deletion/verify?token="],
    [securityUser.email, "/api/account/security/verify?token="],
    [exportUser.email, "/api/account/data-export/verify?token="],
  ]);
  const { requests } = await getProviderRequests();
  const releaseRequests = requests.filter(
    (request) =>
      request.target === providerTarget &&
      [...expectedDestination.keys()].some((email) =>
        request.body.includes(email),
      ),
  );

  expect(releaseRequests).toHaveLength(6);
  const messages = releaseRequests.map((request) => {
    expect(request).toMatchObject({
      target: providerTarget,
      logicalUrl:
        provider === "brevo"
          ? "https://api.brevo.com/v3/smtp/email"
          : "https://api.mailjet.com/v3.1/send",
      method: "POST",
    });
    expect(request.headers.accept).toBe("application/json");
    expect(request.headers["content-type"]).toBe("application/json");
    if (provider === "brevo") {
      expect(request.headers["api-key"]).toBe(providerApiKey);
    } else {
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from(`${providerApiKey}:${providerApiSecret}`).toString("base64")}`,
      );
    }
    return normalizeProviderRequest(request);
  });

  expect(messages.map(({ recipient }) => recipient).toSorted()).toEqual(
    [...expectedDestination.keys()].toSorted(),
  );
  for (const message of messages) {
    expect(message.sender).toEqual({
      email: "no-reply@example.test",
      name: "playwright",
    });
    expect(message.subject.trim()).not.toBe("");
    expect(message.text).toContain("playwright");
    expect(message.html).toContain("playwright");
    expect(message.text).toContain(expectedDestination.get(message.recipient));
  }
  const existingNotice = messages.find(
    ({ recipient }) => recipient === existingSignupUser.email,
  )!;
  expect(existingNotice.text).not.toContain("/api/signup/activate");
  expect(existingNotice.text).not.toMatch(/token=/u);
});