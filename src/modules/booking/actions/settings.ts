"use server";

import "server-only";

import { z } from "zod";

import type { IntegrationProvider } from "@/generated/prisma/enums";
import { BookingSecretError } from "@/lib/booking/secrets";
import { createGravityFormsClient, GravityFormsError } from "@/lib/gravity-forms/client";
import { createHoldedClient, HoldedError } from "@/lib/holded/client";
import { createSmtpSender, SmtpError } from "@/lib/mail/smtp";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  AuthorizationError,
  requireBookingActor,
} from "@/modules/booking/authorization";
import { GRAVITY_FORM_FIELD_KEYS, submittedSecret } from "@/modules/booking/schema";
import {
  IntegrationSettingsError,
  listIntegrationStatus,
  markIntegrationVerified,
  normalizeTaxId,
  readIntegrationConfig,
  resolveIntegration,
  saveIntegrationSettings,
  type IntegrationStatus,
} from "@/modules/booking/services/settings";

export type SettingsActionState =
  | { status: "idle" }
  | { status: "saved" }
  | { status: "verified" }
  | {
      status: "error";
      /** A code, never a provider message: those can echo the credential. */
      reason:
        | "unauthenticated"
        | "forbidden"
        | "invalid"
        | "storage_unavailable"
        | "authentication"
        | "connection"
        | "not_found"
        | "rejected"
        | "unknown";
    };

const providerSchema = z.enum(["HOLDED", "GRAVITY_FORMS", "BOOKING_MAIL"]);

const RATE_SKUS = [
  "dc30",
  "dc40",
  "dc60",
  "dc80",
  "pc30",
  "pc40",
  "pc60",
  "pc80",
] as const;

const smtpFormSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65_535),
  secure: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
  username: z.string().min(1),
  fromEmail: z.email(),
  // Empty means "keep the stored credential" rather than "clear it".
  password: z.string().optional(),
});

function toErrorState(error: unknown): SettingsActionState {
  if (error instanceof AuthorizationError) {
    return { status: "error", reason: error.code };
  }
  if (error instanceof IntegrationSettingsError) {
    return {
      status: "error",
      reason: error.code === "storage_unavailable" ? "storage_unavailable" : "invalid",
    };
  }
  if (error instanceof BookingSecretError) {
    return { status: "error", reason: "storage_unavailable" };
  }
  if (error instanceof SmtpError) {
    return { status: "error", reason: error.code };
  }
  if (error instanceof HoldedError || error instanceof GravityFormsError) {
    if (error.code === "unauthorized") {
      return { status: "error", reason: "authentication" };
    }
    if (error.code === "not_found") {
      return { status: "error", reason: "not_found" };
    }
    return {
      status: "error",
      reason:
        error.code === "unavailable" || error.code === "rate_limited"
          ? "connection"
          : "rejected",
    };
  }
  return { status: "error", reason: "unknown" };
}

export async function readIntegrationStatus(): Promise<IntegrationStatus[]> {
  await requireBookingActor("ADMINISTRATOR");
  return listIntegrationStatus();
}

export async function saveBookingMailSettings(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const actor = await requireBookingActor("ADMINISTRATOR");
    const parsed = smtpFormSchema.parse({
      host: formData.get("host"),
      port: formData.get("port"),
      secure: formData.get("secure") ?? "false",
      username: formData.get("username"),
      fromEmail: formData.get("fromEmail"),
      password: formData.get("password") ?? undefined,
    });

    const password = submittedSecret(parsed.password);

    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: {
        host: parsed.host,
        port: parsed.port,
        secure: parsed.secure,
        username: parsed.username,
        fromEmail: parsed.fromEmail,
      },
      secret: password,
      updatedById: actor.userId,
    });

    logger.info(
      { event: "booking_settings_saved", provider: "BOOKING_MAIL", actorId: actor.userId },
      "booking integration settings saved",
    );

    return { status: "saved" };
  } catch (error) {
    return toErrorState(error);
  }
}

/**
 * Sends a message to the configured sender address so a wrong credential is
 * discovered now rather than when the first confirmation fails to arrive.
 */
export async function testIntegration(
  provider: IntegrationProvider,
): Promise<SettingsActionState> {
  try {
    await requireBookingActor("ADMINISTRATOR");
    const validated = providerSchema.parse(provider);

    if (validated === "BOOKING_MAIL") {
      const { config, secret } = await resolveIntegration("BOOKING_MAIL");
      await createSmtpSender(
        {
          host: config.host,
          port: config.port,
          secure: config.secure,
          username: config.username,
          password: secret,
          fromEmail: config.fromEmail,
        },
        getEnv().PROJECT_NAME.trim(),
      ).verify();
    } else if (validated === "HOLDED") {
      const { secret } = await resolveIntegration("HOLDED");
      await createHoldedClient(secret).ping();
    } else {
      const { config, secret } = await resolveIntegration("GRAVITY_FORMS");
      await createGravityFormsClient({
        apiUrl: config.apiUrl,
        formId: config.formId,
        consumerKey: config.consumerKey,
        consumerSecret: secret,
      }).fetchEntriesAfter(null);
    }

    await markIntegrationVerified(validated);

    return { status: "verified" };
  } catch (error) {
    const state = toErrorState(error);
    logger.warn(
      {
        event: "booking_integration_test_failed",
        provider,
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "booking integration test failed",
    );

    return state;
  }
}

export async function saveHoldedSettings(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const actor = await requireBookingActor("ADMINISTRATOR");

    const serviceIdsBySku = Object.fromEntries(
      RATE_SKUS.map((sku) => [sku, String(formData.get(`service.${sku}`) ?? "").trim()]).filter(
        ([, value]) => value.length > 0,
      ),
    );

    const parsed = z
      .object({
        advanceServiceId: z.string().trim().min(1).optional(),
        depositServiceId: z.string().trim().min(1).optional(),
        paymentMethodId: z.string().trim().min(1).optional(),
        negotiatedServiceId: z.string().trim().min(1).optional(),
        language: z.string().trim().min(2).max(5),
        apiKey: z.string().optional(),
      })
      .parse({
        advanceServiceId: formData.get("advanceServiceId") || undefined,
        depositServiceId: formData.get("depositServiceId") || undefined,
        paymentMethodId: formData.get("paymentMethodId") || undefined,
        negotiatedServiceId: formData.get("negotiatedServiceId") || undefined,
        language: formData.get("language") ?? "ca",
        apiKey: formData.get("apiKey") ?? undefined,
      });

    // One per line, however the operator separates them.
    const negotiatedTaxIds = [
      ...new Set(
        String(formData.get("negotiatedTaxIds") ?? "")
          .split(/[\n,;]/u)
          .map(normalizeTaxId)
          .filter((value) => value.length > 0),
      ),
    ];

    const apiKey = submittedSecret(parsed.apiKey);
    // The form no longer offers this, because Holded exposes no catalogue to
    // pick it from; carried over so saving does not silently discard it.
    const existing = await readIntegrationConfig("HOLDED");
    const mailTemplateId = existing?.mailTemplateId;

    await saveIntegrationSettings({
      provider: "HOLDED",
      config: {
        advanceServiceId: parsed.advanceServiceId,
        depositServiceId: parsed.depositServiceId,
        mailTemplateId: typeof mailTemplateId === "string" ? mailTemplateId : undefined,
        paymentMethodId: parsed.paymentMethodId,
        language: parsed.language,
        serviceIdsBySku,
        negotiatedServiceId: parsed.negotiatedServiceId,
        negotiatedTaxIds,
      },
      secret: apiKey,
      updatedById: actor.userId,
    });

    logger.info(
      { event: "booking_settings_saved", provider: "HOLDED", actorId: actor.userId },
      "booking integration settings saved",
    );

    return { status: "saved" };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function saveGravityFormsSettings(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const actor = await requireBookingActor("ADMINISTRATOR");

    const fieldMap = Object.fromEntries(
      GRAVITY_FORM_FIELD_KEYS.map((key) => [
        key,
        String(formData.get(`field.${key}`) ?? "").trim(),
      ]),
    );

    const parsed = z
      .object({
        apiUrl: z.url(),
        formId: z.string().trim().regex(/^\d+$/u),
        consumerKey: z.string().trim().min(1),
        consumerSecret: z.string().optional(),
      })
      .parse({
        apiUrl: formData.get("apiUrl"),
        formId: formData.get("formId"),
        consumerKey: formData.get("consumerKey"),
        consumerSecret: formData.get("consumerSecret") ?? undefined,
      });

    const consumerSecret = submittedSecret(parsed.consumerSecret);

    await saveIntegrationSettings({
      provider: "GRAVITY_FORMS",
      config: {
        apiUrl: parsed.apiUrl,
        formId: parsed.formId,
        consumerKey: parsed.consumerKey,
        fieldMap,
      },
      secret: consumerSecret ? consumerSecret : undefined,
      updatedById: actor.userId,
    });

    logger.info(
      { event: "booking_settings_saved", provider: "GRAVITY_FORMS", actorId: actor.userId },
      "booking integration settings saved",
    );

    return { status: "saved" };
  } catch (error) {
    return toErrorState(error);
  }
}
