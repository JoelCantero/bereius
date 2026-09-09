// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createMailjetProvider } from "@/lib/email/mailjet";
import type { TransactionalEmail } from "@/lib/email/types";
import { createTestEmailBrand } from "../helpers/email-brand";
import { createHttpMailProvider } from "../helpers/http-mail-provider";
import { getTestProjectName } from "../helpers/project-name";

const projectName = getTestProjectName();
const config = {
  enabled: true as const,
  provider: "mailjet" as const,
  apiKey: "mailjet-key",
  apiSecret: "mailjet-secret",
  fromEmail: "no-reply@example.test",
  senderName: projectName,
  brand: createTestEmailBrand(projectName),
  sendTimeoutMs: 2_500 as const,
  healthTimeoutMs: 1_500 as const,
  responseLimitBytes: 65_536 as const,
};

const message: TransactionalEmail = {
  recipient: "member@example.test",
  locale: "ca",
  subject: "El teu enllac d'acces",
  text: "Utilitza aquest enllac per iniciar sessio",
  html: "<p>Utilitza aquest enllac per iniciar sessio</p>",
};

function success(overrides: Record<string, unknown> = {}) {
  return {
    Messages: [
      {
        Status: "success",
        To: [
          {
            Email: "member@example.test",
            MessageUUID: "mailjet-uuid",
            MessageID: 123,
            MessageHref: "https://provider.example/private",
          },
        ],
        ...overrides,
      },
    ],
  };
}

describe("Mailjet email provider", () => {
  it("posts one message with Basic authentication to the fixed endpoint", async () => {
    const http = createHttpMailProvider([{ body: JSON.stringify(success()) }]);
    const provider = createMailjetProvider(config, http.client);

    await expect(provider.send(message)).resolves.toEqual({
      accepted: true,
      providerMessageId: "mailjet-uuid",
      provider: "mailjet",
      category: "accepted",
    });

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({
      logicalUrl: "https://api.mailjet.com/v3.1/send",
      method: "POST",
    });
    expect(http.requests[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("mailjet-key:mailjet-secret").toString("base64")}`,
    );
    expect(http.requests[0]?.headers.get("accept")).toBe("application/json");
    expect(http.requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(http.requests[0]?.body ?? "null")).toEqual({
      Messages: [
        {
          From: { Email: "no-reply@example.test", Name: projectName },
          ReplyTo: { Email: "support@example.test" },
          To: [{ Email: "member@example.test" }],
          Subject: "El teu enllac d'acces",
          TextPart: "Utilitza aquest enllac per iniciar sessio",
          HTMLPart: "<p>Utilitza aquest enllac per iniciar sessio</p>",
        },
      ],
    });
  });

  it.each([
    [success(), "mailjet-uuid"],
    [success({ To: [{ Email: "member@example.test", MessageUUID: "", MessageID: 456 }] }), "456"],
    [success({ To: [{ Email: "member@example.test" }] }), null],
    [success({ To: [{ Email: "member@example.test", MessageUUID: "unsafe\nid", MessageID: 789 }] }), "789"],
  ])("accepts one structurally valid success %#", async (body, id) => {
    const http = createHttpMailProvider([{ body: JSON.stringify(body) }]);

    await expect(createMailjetProvider(config, http.client).send(message)).resolves.toEqual({
      accepted: true,
      providerMessageId: id,
      provider: "mailjet",
      category: "accepted",
    });
  });

  it.each([
    [{ StatusCode: 400 }, "invalid_request"],
    [{ StatusCode: 401 }, "authentication"],
    [{ StatusCode: 403 }, "authentication"],
    [{ StatusCode: 409 }, "invalid_request"],
    [{ StatusCode: 429 }, "rate_limited"],
    [{ StatusCode: 503 }, "provider_unavailable"],
    [{ StatusCode: 422 }, "unknown"],
    [{ ErrorCode: "mj-001" }, "unknown"],
  ] as const)("classifies embedded Mailjet error %# as %s", async (error, category) => {
    const http = createHttpMailProvider([
      {
        body: JSON.stringify({
          Messages: [{ Status: "error", Errors: [error], To: [{}] }],
        }),
      },
    ]);

    await expect(createMailjetProvider(config, http.client).send(message)).resolves.toEqual({
      accepted: false,
      providerMessageId: null,
      provider: "mailjet",
      category,
    });
  });

  it.each([
    success({ Errors: [{ StatusCode: 400 }] }),
    { Messages: [success().Messages[0], success().Messages[0]] },
    { Messages: [{ Status: "success", To: [] }] },
    { Messages: [{ Status: "success", To: [{}, {}] }] },
    { Messages: [{ Status: "success", To: [{}] }, { Status: "error", Errors: [] }] },
    { Messages: [{ Status: "error", Errors: [{ StatusCode: 400 }, { StatusCode: 500 }], To: [{}] }] },
    {},
  ])("normalizes contradictory or malformed 2xx response %#", async (body) => {
    const http = createHttpMailProvider([{ body: JSON.stringify(body) }]);

    await expect(createMailjetProvider(config, http.client).send(message)).resolves.toEqual({
      accepted: false,
      providerMessageId: null,
      provider: "mailjet",
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
    [302, "unknown"],
    [418, "unknown"],
  ] as const)("maps HTTP %i to %s before body semantics", async (status, category) => {
    const http = createHttpMailProvider([{ status, body: JSON.stringify(success()) }]);

    await expect(createMailjetProvider(config, http.client).send(message)).resolves.toEqual({
      accepted: false,
      providerMessageId: null,
      provider: "mailjet",
      category,
    });
    expect(http.requests).toHaveLength(1);
  });

  it.each([
    { body: "not-json" },
    { body: `"${"x".repeat(65_536)}"` },
    { error: new Error("private network details") },
  ])("normalizes malformed, oversized, and network failures without retry %#", async (behavior) => {
    const http = createHttpMailProvider([behavior]);

    const result = await createMailjetProvider(config, http.client).send(message);

    expect(result).toMatchObject({
      accepted: false,
      providerMessageId: null,
      provider: "mailjet",
      category: "error" in behavior ? "provider_unavailable" : "unknown",
    });
    expect(http.requests).toHaveLength(1);
  });

  it("rejects invalid messages before making a provider request", async () => {
    const http = createHttpMailProvider();

    await expect(
      createMailjetProvider(config, http.client).send({ ...message, text: "" }),
    ).rejects.toThrow("Invalid transactional email");
    expect(http.requests).toHaveLength(0);
  });
});
