// @vitest-environment node

import type { DestinationStream } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("createLogger", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = {
      ...originalEnv,
      PROJECT_NAME: "test-app",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
      AUTH_SECRET: "test-auth-secret-at-least-32-chars-long",
      NEXTAUTH_URL: "https://app.example.test",
      NODE_ENV: "test",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses the configured app name and redacts sensitive fields", async () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(chunk);
      },
    };
    const { createLogger } = await import("@/lib/logger");
    const logger = createLogger(process.env, destination);

    logger.info(
      {
        DATABASE_URL: "postgresql://secret",
        user: { password: "hunter2" },
      },
      "configured",
    );

    const entry = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      app: "test-app",
      env: "test",
      level: "info",
      DATABASE_URL: "[redacted]",
      user: { password: "[redacted]" },
      msg: "configured",
    });
  });

  it("redacts signup PII and token fields", async () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(chunk);
      },
    };
    const { createLogger } = await import("@/lib/logger");
    const logger = createLogger(process.env, destination);

    logger.info(
      {
        signup: {
          email: "member@example.test",
          proposedName: "Taylor",
          token: "plain-token",
          emailHash: "abc123",
        },
      },
      "signup event",
    );

    const entry = JSON.parse(lines.at(-1)!) as {
      signup: Record<string, unknown>;
    };
    expect(entry.signup).toEqual({
      email: "[redacted]",
      proposedName: "[redacted]",
      token: "[redacted]",
      emailHash: "abc123",
    });
  });

  it("redacts account profile failure payload details", async () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(chunk);
      },
    };
    const { createLogger } = await import("@/lib/logger");
    const logger = createLogger(process.env, destination);

    logger.error(
      {
        account: {
          email: "member@example.test",
          name: "Private Member",
          image: "https://cdn.example.test/avatar/member.png",
          sessionToken: "next-auth.session-token=session-secret",
        },
      },
      "account profile update failed",
    );

    const entry = JSON.parse(lines.at(-1)!) as {
      account: Record<string, unknown>;
    };
    expect(entry.account).toEqual({
      email: "[redacted]",
      name: "[redacted]",
      image: "[redacted]",
      sessionToken: "[redacted]",
    });
  });

  it("redacts outbound HTTP credentials, recipients, content, and raw payloads", async () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(chunk);
      },
    };
    const { createLogger } = await import("@/lib/logger");
    const logger = createLogger(process.env, destination);
    const privateValues = {
      apiKey: "private-api-key",
      apiSecret: "private-api-secret",
      authorization: "Basic private-authorization",
      recipient: "private@example.test",
      fromEmail: "sender@example.test",
      subject: "Private subject",
      text: "Private plain text",
      html: "<p>Private HTML</p>",
      body: "private request body",
      raw: "private raw response",
      headers: { "api-key": "private-header-key" },
    };

    logger.info({ outbound: privateValues }, "outbound request");

    const serialized = lines.at(-1)!;
    for (const privateValue of [
      ...Object.values(privateValues).filter(
        (value): value is string => typeof value === "string",
      ),
      "private-header-key",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("logs estimate delivery operations using identifiers without delegate PII", async () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(chunk);
      },
    };
    const { createLogger } = await import("@/lib/logger");
    const logger = createLogger(process.env, destination);
    const privateValues = {
      name: "Private Delegate",
      firstName: "Private",
      lastName: "Delegate",
      email: "delegate@example.test",
      phone: "+34900111222",
      taxId: "12345678Z",
      rawBody: '{"delegate":"private"}',
    };

    logger.info(
      {
        event: "booking_estimate_delivery_prepared",
        linkedPerson: privateValues,
        delivery: {
          holdedDocumentId: "document-42",
          toEmail: "fiscal@example.test",
          ccEmails: [privateValues.email],
          status: "UNKNOWN",
        },
      },
      "delegate operation",
    );

    const serialized = lines.at(-1)!;
    for (const privateValue of [
      ...Object.values(privateValues),
      "fiscal@example.test",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(JSON.parse(serialized)).toMatchObject({
      event: "booking_estimate_delivery_prepared",
      linkedPerson: {
        email: "[redacted]",
        phone: "[redacted]",
      },
      delivery: {
        holdedDocumentId: "document-42",
        status: "UNKNOWN",
      },
    });
  });

  it("creates a child logger with request context", async () => {
    const { getRequestLogger } = await import("@/lib/logger");
    const request = new Request("https://example.test/api/health", {
      headers: { "x-request-id": "request-42" },
    });

    const requestLogger = getRequestLogger(request, { route: "/api/health" });

    expect(requestLogger.bindings()).toMatchObject({
      requestId: "request-42",
      route: "/api/health",
    });
  });
});