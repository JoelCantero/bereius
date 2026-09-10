import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateEnv } from "@/lib/env";

describe("validateEnv", () => {
  const originalEnv = process.env;
  const validBrandEnv = {
    BRAND_COLOR: "#0057b8",
    SUPPORT_EMAIL: "support@example.test",
    MAIL_LOGO_URL: "https://assets.example.test/mail/logo.png?v=1",
  };
  const normalizedBrand = {
    productName: "test-app",
    canonicalOrigin: "https://app.example.com",
    primaryColor: "#0057B8",
    actionForeground: "#FFFFFF",
    supportEmail: "support@example.test",
    logoUrl: "https://assets.example.test/mail/logo.png?v=1",
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PROJECT_NAME;
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MAIL_ENABLED;
    delete process.env.MAIL_PROVIDER;
    delete process.env.MAIL_API_KEY;
    delete process.env.MAIL_API_SECRET;
    delete process.env.MAIL_FROM;
    delete process.env.BRAND_COLOR;
    delete process.env.SUPPORT_EMAIL;
    delete process.env.MAIL_LOGO_URL;
    delete process.env.MAIL_API_BASE_URL;
    delete process.env.MAIL_FROM_NAME;
    delete process.env.TRUST_PROXY_HEADERS;
    delete process.env.BOOKING_SECRET_KEY;
    Object.assign(process.env, validBrandEnv);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when required env vars are missing", () => {
    expect(() => validateEnv(process.env)).toThrow(/DATABASE_URL/);
  });

  it("returns a normalized config when required env vars are present", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";

    const env = validateEnv(process.env);

    expect(env).toMatchObject({
      PROJECT_NAME: "test-app",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
      AUTH_SECRET: "test-auth-secret-at-least-32-chars-long",
      NEXTAUTH_URL: "https://app.example.com",
    });
  });

  it("rejects a canonical auth URL with a path", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com/untrusted-base";

    expect(() => validateEnv(process.env)).toThrow(/NEXTAUTH_URL/);
  });

  it("throws when AUTH_SECRET is shorter than 32 characters", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "too-short";
    process.env.NEXTAUTH_URL = "https://app.example.com";

    expect(() => validateEnv(process.env)).toThrow(/AUTH_SECRET/);
  });

  it("accepts a recognized LOG_LEVEL", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.LOG_LEVEL = "debug";

    expect(validateEnv(process.env)).toMatchObject({ LOG_LEVEL: "debug" });
  });

  it("throws when LOG_LEVEL is not a recognized level", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.LOG_LEVEL = "verbose";

    expect(() => validateEnv(process.env)).toThrow(/LOG_LEVEL/);
  });

  it("treats an empty LOG_LEVEL as unset", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.LOG_LEVEL = "";

    expect(validateEnv(process.env)).toMatchObject({ LOG_LEVEL: undefined });
  });

  it("keeps all transactional email disabled by default", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";

    expect(validateEnv(process.env)).toMatchObject({
      MAIL: { enabled: false },
      TRUST_PROXY_HEADERS: false,
    });
  });

  it("does not let provider credentials enable a disabled gate", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_ENABLED = "false";
    process.env.MAIL_PROVIDER = "mailjet";
    process.env.MAIL_API_KEY = "unused-key";
    process.env.MAIL_API_SECRET = "unused-secret";
    process.env.MAIL_FROM = "unused@example.test";

    expect(validateEnv(process.env).MAIL).toEqual({ enabled: false });
  });

  it("requires valid global brand settings while mail is disabled", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    for (const field of Object.keys(validBrandEnv)) delete process.env[field];

    expect(() => validateEnv(process.env)).toThrow(/BRAND_COLOR/);

    Object.assign(process.env, validBrandEnv, {
      BRAND_COLOR: "not-a-color",
    });
    expect(() => validateEnv(process.env)).toThrow(/BRAND_COLOR/);
  });

  it("ignores the email logo setting while mail is disabled", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_LOGO_URL = "http://invalid.example.test/logo.png";

    expect(validateEnv(process.env)).toMatchObject({
      BRAND: { ...normalizedBrand, logoUrl: null },
      MAIL: { enabled: false },
    });
  });

  it("normalizes complete Brevo configuration and drops a Mailjet secret", () => {
    process.env.PROJECT_NAME = "  test-app  ";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_PROVIDER = "brevo";
    process.env.MAIL_API_KEY = "brevo-key";
    process.env.MAIL_API_SECRET = "must-not-survive";
    process.env.MAIL_FROM = "no-reply@example.test";

    expect(validateEnv(process.env).MAIL).toEqual({
      enabled: true,
      provider: "brevo",
      apiKey: "brevo-key",
      fromEmail: "no-reply@example.test",
      senderName: "test-app",
      brand: normalizedBrand,
      sendTimeoutMs: 2_500,
      healthTimeoutMs: 1_500,
      responseLimitBytes: 65_536,
    });
  });

  it("normalizes complete Mailjet configuration", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_PROVIDER = "mailjet";
    process.env.MAIL_API_KEY = "mailjet-key";
    process.env.MAIL_API_SECRET = "mailjet-secret";
    process.env.MAIL_FROM = "no-reply@example.test";

    expect(validateEnv(process.env).MAIL).toEqual({
      enabled: true,
      provider: "mailjet",
      apiKey: "mailjet-key",
      apiSecret: "mailjet-secret",
      fromEmail: "no-reply@example.test",
      senderName: "test-app",
      brand: normalizedBrand,
      sendTimeoutMs: 2_500,
      healthTimeoutMs: 1_500,
      responseLimitBytes: 65_536,
    });
  });

  it.each(["1", "yes", "TRUE", " true "])(
    "rejects invalid MAIL_ENABLED value %j",
    (value) => {
      process.env.PROJECT_NAME = "test-app";
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
      process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
      process.env.NEXTAUTH_URL = "https://app.example.com";
      process.env.MAIL_ENABLED = value;

      expect(() => validateEnv(process.env)).toThrow(/MAIL_ENABLED/);
    },
  );

  it.each([undefined, "resend", "Brevo"])(
    "rejects enabled unsupported provider %j",
    (provider) => {
      process.env.PROJECT_NAME = "test-app";
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
      process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
      process.env.NEXTAUTH_URL = "https://app.example.com";
      process.env.MAIL_ENABLED = "true";
      if (provider) process.env.MAIL_PROVIDER = provider;
      process.env.MAIL_API_KEY = "provider-key";
      process.env.MAIL_FROM = "no-reply@example.test";

      expect(() => validateEnv(process.env)).toThrow(/MAIL_PROVIDER/);
    },
  );

  it.each([
    ["MAIL_API_KEY", "brevo", undefined],
    ["MAIL_API_SECRET", "mailjet", "provider-key"],
    ["MAIL_FROM", "brevo", "provider-key"],
  ])("requires %s for enabled %s", (field, provider, apiKey) => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_PROVIDER = provider;
    if (apiKey) process.env.MAIL_API_KEY = apiKey;
    if (field !== "MAIL_FROM") process.env.MAIL_FROM = "no-reply@example.test";

    expect(() => validateEnv(process.env)).toThrow(new RegExp(field));
  });

  it.each(["BRAND_COLOR", "SUPPORT_EMAIL"])(
    "requires global brand setting %s",
    (field) => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    delete process.env[field];

    expect(() => validateEnv(process.env)).toThrow(new RegExp(field));
    },
  );

  it.each([
    ["BRAND_COLOR", "#123"],
    ["BRAND_COLOR", "0057B8"],
    ["SUPPORT_EMAIL", "Support <support@example.test>"],
    ["MAIL_LOGO_URL", "http://assets.example.test/logo.png"],
    ["MAIL_LOGO_URL", "https://user@assets.example.test/logo.png"],
    ["MAIL_LOGO_URL", "https://assets.example.test/logo.png#tracking"],
  ])("rejects malformed applicable brand setting %s", (field, value) => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_PROVIDER = "brevo";
    process.env.MAIL_API_KEY = "provider-key";
    process.env.MAIL_FROM = "no-reply@example.test";
    process.env[field] = value;

    expect(() => validateEnv(process.env)).toThrow(new RegExp(field));
    try {
      validateEnv(process.env);
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });

  it("normalizes an empty optional logo to null", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_PROVIDER = "brevo";
    process.env.MAIL_API_KEY = "provider-key";
    process.env.MAIL_FROM = "no-reply@example.test";
    process.env.MAIL_LOGO_URL = "";

    expect(validateEnv(process.env).MAIL).toMatchObject({
      enabled: true,
      brand: { ...normalizedBrand, logoUrl: null },
    });
  });

  it("rejects credentials in the canonical brand origin", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://user@app.example.com";
    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_PROVIDER = "brevo";
    process.env.MAIL_API_KEY = "provider-key";
    process.env.MAIL_FROM = "no-reply@example.test";

    expect(() => validateEnv(process.env)).toThrow(/NEXTAUTH_URL/);
  });

  it.each([
    ["MAIL_FROM", "Display Name <no-reply@example.test>"],
    ["MAIL_FROM", "not-an-email"],
    ["PROJECT_NAME", "x".repeat(71)],
    ["PROJECT_NAME", "unsafe\nname"],
  ])("rejects invalid %s", (field, value) => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_PROVIDER = "brevo";
    process.env.MAIL_API_KEY = "provider-key";
    process.env.MAIL_FROM = "no-reply@example.test";
    process.env[field] = value;

    expect(() => validateEnv(process.env)).toThrow(new RegExp(field));
  });

  it("keeps validation errors redacted and ignores unsupported endpoint variables", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.MAIL_ENABLED = "true";
    process.env.MAIL_PROVIDER = "brevo";
    process.env.MAIL_API_KEY = "fixture-private-api-key";
    process.env.MAIL_FROM = "private-invalid-sender";
    process.env.MAIL_API_BASE_URL = "https://attacker.example";
    process.env.MAIL_FROM_NAME = "Injected Sender";

    expect(() => validateEnv(process.env)).toThrow(/MAIL_FROM/);
    try {
      validateEnv(process.env);
    } catch (error) {
      const output = String(error);
      expect(output).not.toContain("fixture-private-api-key");
      expect(output).not.toContain("private-invalid-sender");
      expect(output).not.toContain("attacker.example");
    }

    process.env.MAIL_FROM = "no-reply@example.test";
    const env = validateEnv(process.env);
    expect(env).not.toHaveProperty("MAIL_API_BASE_URL");
    expect(env).not.toHaveProperty("MAIL_FROM_NAME");
  });

  it("normalizes an explicitly trusted proxy boundary", () => {
    process.env.PROJECT_NAME = "test-app";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
    process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
    process.env.NEXTAUTH_URL = "https://app.example.com";
    process.env.TRUST_PROXY_HEADERS = "true";

    expect(validateEnv(process.env)).toMatchObject({ TRUST_PROXY_HEADERS: true });
  });

  describe("booking pipeline", () => {
    const secretKey = Buffer.alloc(32, 7).toString("base64");

    function setRequiredEnv() {
      process.env.PROJECT_NAME = "test-app";
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/app";
      process.env.AUTH_SECRET = "test-auth-secret-at-least-32-chars-long";
      process.env.NEXTAUTH_URL = "https://app.example.com";
    }

    it("leaves the envelope key unset when it is not provided", () => {
      setRequiredEnv();

      expect(validateEnv(process.env).BOOKING).toEqual({ secretKey: null });
    });

    it("decodes a valid envelope key at startup", () => {
      setRequiredEnv();
      process.env.BOOKING_SECRET_KEY = secretKey;

      expect(validateEnv(process.env).BOOKING.secretKey).toEqual(
        Buffer.from(secretKey, "base64"),
      );
    });

    it.each([
      Buffer.alloc(16, 1).toString("base64"),
      Buffer.alloc(64, 1).toString("base64"),
      "not base64 at all !!",
    ])("rejects an envelope key that is not 32 bytes %j", (key) => {
      setRequiredEnv();
      process.env.BOOKING_SECRET_KEY = key;

      expect(() => validateEnv(process.env)).toThrow(/BOOKING_SECRET_KEY/);
    });

    it("keeps the envelope key out of validation failures", () => {
      setRequiredEnv();
      process.env.BOOKING_SECRET_KEY = "short-but-secret-looking-value";

      try {
        validateEnv(process.env);
        expect.unreachable("expected validation to fail");
      } catch (error) {
        const output = String(error);
        expect(output).toContain("BOOKING_SECRET_KEY");
        expect(output).not.toContain("short-but-secret-looking-value");
      }
    });

    it("exposes no integration credential, because they are application settings", () => {
      setRequiredEnv();
      process.env.BOOKING_SECRET_KEY = secretKey;

      const env = validateEnv(process.env);

      expect(Object.keys(env.BOOKING)).toEqual(["secretKey"]);
      for (const removed of [
        "BOOKING_ENABLED",
        "HOLDED_API_KEY",
        "GRAVITY_FORMS_API_URL",
        "GRAVITY_FORMS_CONSUMER_KEY",
        "GRAVITY_FORMS_CONSUMER_SECRET",
        "GRAVITY_FORMS_FORM_ID",
      ]) {
        expect(env).not.toHaveProperty(removed);
      }
    });
  });
});
