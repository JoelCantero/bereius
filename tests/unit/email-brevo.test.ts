// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createBrevoProvider } from "@/lib/email/brevo";
import {
  EMAIL_RESPONSE_LIMIT_BYTES,
  type TransactionalEmail,
} from "@/lib/email/types";
import { createTestEmailBrand } from "../helpers/email-brand";
import { createHttpMailProvider } from "../helpers/http-mail-provider";
import { getTestProjectName } from "../helpers/project-name";

const projectName = getTestProjectName();
const config = {
  enabled: true as const,
  provider: "brevo" as const,
  apiKey: "brevo-private-key",
  fromEmail: "no-reply@example.test",
  senderName: projectName,
  brand: createTestEmailBrand(projectName),
  sendTimeoutMs: 2_500 as const,
  healthTimeoutMs: 1_500 as const,
  responseLimitBytes: 65_536 as const,
};

const message: TransactionalEmail = {
  recipient: "member@example.test",
  locale: "es",
  subject: "Tu enlace de acceso",
  text: "Usa este enlace para iniciar sesion",
  html: "<p>Usa este enlace para iniciar sesion</p>",
};

describe("Brevo email provider", () => {
  it("posts one transactional message to the fixed endpoint", async () => {
    const http = createHttpMailProvider([
      { body: JSON.stringify({ messageId: " brevo-id " }) },
    ]);
    const provider = createBrevoProvider(config, http.client);

    await expect(provider.send(message)).resolves.toEqual({
      accepted: true,
      providerMessageId: "brevo-id",
      provider: "brevo",
      category: "accepted",
    });

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({
      logicalUrl: "https://api.brevo.com/v3/smtp/email",
      method: "POST",
    });
    expect(http.requests[0]?.headers.get("api-key")).toBe("brevo-private-key");
    expect(http.requests[0]?.headers.get("accept")).toBe("application/json");
    expect(http.requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(http.requests[0]?.body ?? "null")).toEqual({
      sender: { email: "no-reply@example.test", name: projectName },
      replyTo: { email: "support@example.test" },
      to: [{ email: "member@example.test" }],
      subject: "Tu enlace de acceso",
      textContent: "Usa este enlace para iniciar sesion",
      htmlContent: "<p>Usa este enlace para iniciar sesion</p>",
    });
  });

  it.each([
    [{}, null],
    [{ messageId: "" }, null],
    [{ messageId: `id-${"x".repeat(512)}` }, null],
    [{ messageId: "unsafe\nidentifier" }, null],
    [{ messageIds: ["single-id"] }, "single-id"],
    [{ messageId: "same-id", messageIds: ["same-id"] }, "same-id"],
  ])("accepts a valid 2xx response with normalized identifier %#", async (body, id) => {
    const http = createHttpMailProvider([{ body: JSON.stringify(body) }]);

    await expect(createBrevoProvider(config, http.client).send(message)).resolves.toEqual({
      accepted: true,
      providerMessageId: id,
      provider: "brevo",
      category: "accepted",
    });
  });

  it.each([
    { messageId: "first", messageIds: ["second"] },
    { messageIds: ["first", "second"] },
    { code: "invalid_parameter", message: "provider details" },
    [],
  ])("rejects contradictory or error-shaped 2xx response %#", async (body) => {
    const http = createHttpMailProvider([{ body: JSON.stringify(body) }]);

    await expect(createBrevoProvider(config, http.client).send(message)).resolves.toEqual({
      accepted: false,
      providerMessageId: null,
      provider: "brevo",
      category: "unknown",
    });
  });

  it.each([
    [400, "invalid_request"],
    [401, "authentication"],
    [403, "authentication"],
    [409, "invalid_request"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [302, "unknown"],
    [418, "unknown"],
  ] as const)("maps HTTP %i to %s", async (status, category) => {
    const http = createHttpMailProvider([{ status, body: "{}" }]);

    await expect(createBrevoProvider(config, http.client).send(message)).resolves.toEqual({
      accepted: false,
      providerMessageId: null,
      provider: "brevo",
      category,
    });
    expect(http.requests).toHaveLength(1);
  });

  it.each([
    { body: "not-json" },
    { body: `"${"x".repeat(EMAIL_RESPONSE_LIMIT_BYTES)}"` },
    { error: new Error("private network details") },
  ])("normalizes malformed, oversized, or network failures without retry %#", async (behavior) => {
    const http = createHttpMailProvider([behavior]);

    const result = await createBrevoProvider(config, http.client).send(message);

    expect(result.accepted).toBe(false);
    expect(result.providerMessageId).toBeNull();
    expect(result.provider).toBe("brevo");
    expect(result.category).toBe(
      "error" in behavior ? "provider_unavailable" : "unknown",
    );
    expect(http.requests).toHaveLength(1);
  });

  it("rejects invalid messages before making a provider request", async () => {
    const http = createHttpMailProvider();
    const provider = createBrevoProvider(config, http.client);

    await expect(provider.send({ ...message, html: "" })).rejects.toThrow(
      "Invalid transactional email",
    );
    expect(http.requests).toHaveLength(0);
  });
});
