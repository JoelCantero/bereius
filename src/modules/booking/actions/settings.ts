"use server";

import "server-only";

import { z } from "zod";

import type { IntegrationProvider } from "@/generated/prisma/enums";
import { BookingSecretError } from "@/lib/booking/secrets";
import { createSmtpSender, SmtpError } from "@/lib/mail/smtp";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  AuthorizationError,
  requireBookingActor,
} from "@/modules/booking/authorization";
import {
  IntegrationSettingsError,
  listIntegrationStatus,
  markIntegrationVerified,
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
        | "rejected"
        | "unknown";
    };

const providerSchema = z.enum(["HOLDED", "GRAVITY_FORMS", "BOOKING_MAIL"]);

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

    const password = parsed.password?.trim();

    await saveIntegrationSettings({
      provider: "BOOKING_MAIL",
      config: {
        host: parsed.host,
        port: parsed.port,
        secure: parsed.secure,
        username: parsed.username,
        fromEmail: parsed.fromEmail,
      },
      secret: password ? password : undefined,
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

    if (validated !== "BOOKING_MAIL") {
      return { status: "error", reason: "invalid" };
    }

    const { resolveIntegration } = await import(
      "@/modules/booking/services/settings"
    );
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

    await markIntegrationVerified("BOOKING_MAIL");

    return { status: "verified" };
  } catch (error) {
    return toErrorState(error);
  }
}

export { createSmtpSender };
