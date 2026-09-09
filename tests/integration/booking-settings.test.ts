// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

import { db } from "@/lib/db";
import {
  IntegrationSettingsError,
  listIntegrationStatus,
  markIntegrationVerified,
  resolveIntegration,
  saveIntegrationSettings,
} from "@/modules/booking/services/settings";

const SMTP_CONFIG = {
  host: "mail.example.test",
  port: 587,
  secure: false,
  username: "hola@example.test",
  fromEmail: "hola@example.test",
};

describe.skipIf(!runIntegrationTests)("booking integration settings", () => {
  afterEach(async () => {
    await db.integrationSettings.deleteMany({ where: { provider: "BOOKING_MAIL" } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("stores a credential encrypted and returns it only through the resolver", async () => {
    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: SMTP_CONFIG,
      secret: "super-secret-password",
      updatedById: null,
    });

    const row = await db.integrationSettings.findUniqueOrThrow({
      where: { provider: "BOOKING_MAIL" },
    });
    expect(Buffer.from(row.secretCiphertext!).toString("utf8")).not.toContain(
      "super-secret-password",
    );

    await expect(resolveIntegration("BOOKING_MAIL")).resolves.toMatchObject({
      secret: "super-secret-password",
      config: SMTP_CONFIG,
    });
  });

  it("never reports the credential in the settings listing", async () => {
    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: SMTP_CONFIG,
      secret: "super-secret-password",
      updatedById: null,
    });

    const statuses = await listIntegrationStatus();
    const mail = statuses.find((status) => status.provider === "BOOKING_MAIL");

    expect(mail).toMatchObject({ configured: true, hasSecret: true });
    expect(JSON.stringify(statuses)).not.toContain("super-secret-password");
  });

  it("keeps the stored credential when only the configuration changes", async () => {
    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: SMTP_CONFIG,
      secret: "original-password",
      updatedById: null,
    });

    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: { ...SMTP_CONFIG, host: "mail2.example.test" },
      updatedById: null,
    });

    const resolved = await resolveIntegration("BOOKING_MAIL");
    expect(resolved.secret).toBe("original-password");
    expect(resolved.config.host).toBe("mail2.example.test");
  });

  it("replaces the credential when a new one is supplied", async () => {
    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: SMTP_CONFIG,
      secret: "original-password",
      updatedById: null,
    });
    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: SMTP_CONFIG,
      secret: "rotated-password",
      updatedById: null,
    });

    await expect(resolveIntegration("BOOKING_MAIL")).resolves.toMatchObject({
      secret: "rotated-password",
    });
  });

  it("clears the verification stamp when the credential is replaced", async () => {
    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: SMTP_CONFIG,
      secret: "original-password",
      updatedById: null,
    });
    await markIntegrationVerified("BOOKING_MAIL");

    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: SMTP_CONFIG,
      secret: "rotated-password",
      updatedById: null,
    });

    await expect(
      db.integrationSettings.findUniqueOrThrow({ where: { provider: "BOOKING_MAIL" } }),
    ).resolves.toMatchObject({ verifiedAt: null });
  });

  it("refuses the first save without a credential", async () => {
    await expect(
      saveIntegrationSettings({
        provider: "BOOKING_MAIL",
        config: SMTP_CONFIG,
        updatedById: null,
      }),
    ).rejects.toBeInstanceOf(IntegrationSettingsError);
  });

  it("refuses a configuration that does not match the provider schema", async () => {
    await expect(
      saveIntegrationSettings({
        provider: "BOOKING_MAIL",
        config: { ...SMTP_CONFIG, port: 70_000 },
        secret: "password",
        updatedById: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("reports an unconfigured integration rather than returning an empty credential", async () => {
    await expect(resolveIntegration("BOOKING_MAIL")).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("accepts a Holded key before the identifiers have been chosen", async () => {
    await saveIntegrationSettings({
      provider: "HOLDED",
      config: { language: "ca", serviceIdsBySku: {} },
      secret: "holded-key",
      updatedById: null,
    });

    const resolved = await resolveIntegration("HOLDED");
    expect(resolved.secret).toBe("holded-key");
    expect(resolved.config.accountingAccountId).toBeUndefined();
    expect(resolved.config.depositServiceId).toBeUndefined();

    await db.integrationSettings.deleteMany({ where: { provider: "HOLDED" } });
  });
});
