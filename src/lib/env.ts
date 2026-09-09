import { z } from "zod";

import {
  EMAIL_HEALTH_TIMEOUT_MS,
  EMAIL_RESPONSE_LIMIT_BYTES,
  EMAIL_SEND_TIMEOUT_MS,
} from "@/lib/email/types";
import {
  EmailBrandValidationError,
  validateEmailBrand,
} from "@/lib/email/presentation/brand";
import type { EmailBrand } from "@/lib/email/presentation/types";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

function positiveIntegerSetting(name: string, defaultValue: number) {
  return z.preprocess(
    (value) => emptyToUndefined(value) ?? String(defaultValue),
    z
      .string()
      .regex(new RegExp(`^[1-9]\\d*$`), `${name} must be a positive integer`)
      .transform(Number)
      .refine(Number.isSafeInteger, `${name} must be a safe integer`),
  );
}

export interface DisabledMailConfig {
  enabled: false;
}

interface EnabledMailConfigBase {
  enabled: true;
  apiKey: string;
  fromEmail: string;
  senderName: string;
  brand: EmailBrand;
  sendTimeoutMs: typeof EMAIL_SEND_TIMEOUT_MS;
  healthTimeoutMs: typeof EMAIL_HEALTH_TIMEOUT_MS;
  responseLimitBytes: typeof EMAIL_RESPONSE_LIMIT_BYTES;
}

export interface BrevoMailConfig extends EnabledMailConfigBase {
  provider: "brevo";
}

export interface MailjetMailConfig extends EnabledMailConfigBase {
  provider: "mailjet";
  apiSecret: string;
}

export type MailConfig =
  | DisabledMailConfig
  | BrevoMailConfig
  | MailjetMailConfig;

/** AES-256-GCM key length for the stored booking SMTP password. */
export const BOOKING_MAIL_KEY_BYTES = 32;

interface DisabledBookingConfig {
  enabled: false;
}

export interface EnabledBookingConfig {
  enabled: true;
  holded: { apiKey: string };
  gravityForms: {
    apiUrl: string;
    consumerKey: string;
    consumerSecret: string;
    formId: string;
  };
  /** Decoded at startup so an unusable key fails fast rather than at first send. */
  mailSecretKey: Buffer;
}

export type BookingConfig = DisabledBookingConfig | EnabledBookingConfig;

function decodeBookingMailKey(value: string): Buffer | null {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    return null;
  }
  return decoded.length === BOOKING_MAIL_KEY_BYTES ? decoded : null;
}

function validateBookingConfig(
  env: Partial<Record<BookingEnvField, string>> & { BOOKING_ENABLED: boolean },
  context: z.RefinementCtx,
): void {
  if (!env.BOOKING_ENABLED) return;

  for (const field of [
    "HOLDED_API_KEY",
    "GRAVITY_FORMS_CONSUMER_KEY",
    "GRAVITY_FORMS_CONSUMER_SECRET",
    "GRAVITY_FORMS_FORM_ID",
  ] as const) {
    if (env[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is required when booking is enabled`,
      });
    }
  }

  const gravityFormsUrl = env.GRAVITY_FORMS_API_URL;
  if (
    gravityFormsUrl === undefined ||
    !z.url().safeParse(gravityFormsUrl).success ||
    new URL(gravityFormsUrl).protocol !== "https:"
  ) {
    context.addIssue({
      code: "custom",
      path: ["GRAVITY_FORMS_API_URL"],
      message: "GRAVITY_FORMS_API_URL must be an HTTPS URL",
    });
  }

  if (
    env.BOOKING_MAIL_KEY === undefined ||
    decodeBookingMailKey(env.BOOKING_MAIL_KEY) === null
  ) {
    context.addIssue({
      code: "custom",
      path: ["BOOKING_MAIL_KEY"],
      message: `BOOKING_MAIL_KEY must be ${BOOKING_MAIL_KEY_BYTES} bytes encoded as base64 (use \`openssl rand -base64 ${BOOKING_MAIL_KEY_BYTES}\`)`,
    });
  }
}

type BookingEnvField =
  | "HOLDED_API_KEY"
  | "GRAVITY_FORMS_API_URL"
  | "GRAVITY_FORMS_CONSUMER_KEY"
  | "GRAVITY_FORMS_CONSUMER_SECRET"
  | "GRAVITY_FORMS_FORM_ID"
  | "BOOKING_MAIL_KEY";

const rawEnvSchema = z
  .object({
    PROJECT_NAME: z.string().min(1, "PROJECT_NAME is required"),
    DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
    // At least 32 chars: matches `openssl rand -base64 32` output and rejects weak
    // or placeholder secrets at startup (constitution Principle X).
    AUTH_SECRET: z
      .string()
      .min(32, "AUTH_SECRET must be at least 32 characters (use `openssl rand -base64 32`)"),
    NEXTAUTH_URL: z
      .url("NEXTAUTH_URL must be a valid URL")
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          url.username === "" &&
          url.password === "" &&
          url.pathname === "/" &&
          url.search === "" &&
          url.hash === ""
        );
      }, "NEXTAUTH_URL must be an HTTP(S) origin without a path, query, or fragment"),
    // Pino log level. Optional: the logger defaults to `info` in production and
    // `debug` otherwise (constitution Principle VIII). An empty string (e.g. an
    // unset GitHub Variable passed through by Compose) is treated as unset; any
    // other invalid value fails fast.
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
    ),
    MAIL_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    ),
    MAIL_PROVIDER: optionalString,
    MAIL_API_KEY: optionalString,
    MAIL_API_SECRET: optionalString,
    MAIL_FROM: optionalString,
    BRAND_COLOR: optionalString,
    SUPPORT_EMAIL: optionalString,
    MAIL_LOGO_URL: optionalString,
    ACCOUNT_DATA_EXPORT_MAX_BYTES: positiveIntegerSetting(
      "ACCOUNT_DATA_EXPORT_MAX_BYTES",
      26_214_400,
    ),
    ACCOUNT_DATA_EXPORT_TIMEOUT_MS: positiveIntegerSetting(
      "ACCOUNT_DATA_EXPORT_TIMEOUT_MS",
      30_000,
    ),
    TRUST_PROXY_HEADERS: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    ),
    BOOKING_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    ),
    HOLDED_API_KEY: optionalString,
    GRAVITY_FORMS_API_URL: optionalString,
    GRAVITY_FORMS_CONSUMER_KEY: optionalString,
    GRAVITY_FORMS_CONSUMER_SECRET: optionalString,
    GRAVITY_FORMS_FORM_ID: optionalString,
    BOOKING_MAIL_KEY: optionalString,
  })
  .superRefine((env, context) => {
    const senderName = env.PROJECT_NAME.trim();
    if (
      senderName.length === 0 ||
      senderName.length > 70 ||
      /[\u0000-\u001f\u007f]/u.test(senderName)
    ) {
      context.addIssue({
        code: "custom",
        path: ["PROJECT_NAME"],
        message: "PROJECT_NAME must be a safe sender name of 1-70 characters",
      });
    }

    const validationBrand = {
      productName: "Example Workspace",
      canonicalOrigin: "https://app.example.test",
      primaryColor: "#0057B8",
      supportEmail: "support@example.test",
      logoUrl: null,
    } as const;
    const brandFields = [
      {
        envField: "BRAND_COLOR",
        brandField: "primaryColor",
        value: env.BRAND_COLOR,
        required: true,
        rule: "must be a six-digit #RRGGBB color",
      },
      {
        envField: "SUPPORT_EMAIL",
        brandField: "supportEmail",
        value: env.SUPPORT_EMAIL,
        required: true,
        rule: "must be one bare email address",
      },
      {
        envField: "MAIL_LOGO_URL",
        brandField: "logoUrl",
        value: env.MAIL_LOGO_URL,
        required: false,
        rule: "must be an absolute HTTPS URL without credentials or a fragment",
      },
    ] as const;

    for (const field of brandFields) {
      if (field.envField === "MAIL_LOGO_URL" && !env.MAIL_ENABLED) continue;

      if (field.value === undefined && field.required) {
        context.addIssue({
          code: "custom",
          path: [field.envField],
          message: `${field.envField} is required`,
        });
        continue;
      }
      if (field.value === undefined) continue;

      try {
        validateEmailBrand({
          ...validationBrand,
          [field.brandField]: field.value,
        });
      } catch (error) {
        if (error instanceof EmailBrandValidationError) {
          context.addIssue({
            code: "custom",
            path: [field.envField],
            message: `${field.envField} ${field.rule}`,
          });
          continue;
        }
        throw error;
      }
    }

    validateBookingConfig(env, context);

    if (!env.MAIL_ENABLED) return;

    if (env.MAIL_PROVIDER !== "brevo" && env.MAIL_PROVIDER !== "mailjet") {
      context.addIssue({
        code: "custom",
        path: ["MAIL_PROVIDER"],
        message: "MAIL_PROVIDER must be brevo or mailjet when mail is enabled",
      });
    }
    if (env.MAIL_API_KEY === undefined) {
      context.addIssue({
        code: "custom",
        path: ["MAIL_API_KEY"],
        message: "MAIL_API_KEY is required when mail is enabled",
      });
    }
    if (env.MAIL_PROVIDER === "mailjet" && env.MAIL_API_SECRET === undefined) {
      context.addIssue({
        code: "custom",
        path: ["MAIL_API_SECRET"],
        message: "MAIL_API_SECRET is required for Mailjet",
      });
    }

    const sender = env.MAIL_FROM;
    if (
      sender === undefined ||
      sender !== sender.trim() ||
      !z.email().safeParse(sender).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["MAIL_FROM"],
        message: "MAIL_FROM must be one bare email address",
      });
    }
  });

type RawEnv = z.infer<typeof rawEnvSchema>;

export type Env = Pick<
  RawEnv,
  | "PROJECT_NAME"
  | "DATABASE_URL"
  | "AUTH_SECRET"
  | "NEXTAUTH_URL"
  | "LOG_LEVEL"
  | "ACCOUNT_DATA_EXPORT_MAX_BYTES"
  | "ACCOUNT_DATA_EXPORT_TIMEOUT_MS"
  | "TRUST_PROXY_HEADERS"
> & { BRAND: EmailBrand; MAIL: MailConfig; BOOKING: BookingConfig };

const envSchema = rawEnvSchema.transform((env): Env => {
  const brand = validateEmailBrand({
    productName: env.PROJECT_NAME,
    canonicalOrigin: env.NEXTAUTH_URL,
    primaryColor: env.BRAND_COLOR,
    supportEmail: env.SUPPORT_EMAIL,
    logoUrl: env.MAIL_ENABLED ? env.MAIL_LOGO_URL : undefined,
  });
  const base = {
    PROJECT_NAME: env.PROJECT_NAME,
    DATABASE_URL: env.DATABASE_URL,
    AUTH_SECRET: env.AUTH_SECRET,
    NEXTAUTH_URL: env.NEXTAUTH_URL,
    LOG_LEVEL: env.LOG_LEVEL,
    ACCOUNT_DATA_EXPORT_MAX_BYTES: env.ACCOUNT_DATA_EXPORT_MAX_BYTES,
    ACCOUNT_DATA_EXPORT_TIMEOUT_MS: env.ACCOUNT_DATA_EXPORT_TIMEOUT_MS,
    TRUST_PROXY_HEADERS: env.TRUST_PROXY_HEADERS,
    BRAND: brand,
    BOOKING: env.BOOKING_ENABLED
      ? ({
          enabled: true,
          holded: { apiKey: env.HOLDED_API_KEY! },
          gravityForms: {
            apiUrl: env.GRAVITY_FORMS_API_URL!,
            consumerKey: env.GRAVITY_FORMS_CONSUMER_KEY!,
            consumerSecret: env.GRAVITY_FORMS_CONSUMER_SECRET!,
            formId: env.GRAVITY_FORMS_FORM_ID!,
          },
          mailSecretKey: decodeBookingMailKey(env.BOOKING_MAIL_KEY!)!,
        } satisfies EnabledBookingConfig)
      : ({ enabled: false } as const),
  };

  if (!env.MAIL_ENABLED) {
    return { ...base, MAIL: { enabled: false } };
  }

  const common = {
    enabled: true as const,
    apiKey: env.MAIL_API_KEY!,
    fromEmail: env.MAIL_FROM!,
    senderName: env.PROJECT_NAME.trim(),
    brand,
    sendTimeoutMs: EMAIL_SEND_TIMEOUT_MS,
    healthTimeoutMs: EMAIL_HEALTH_TIMEOUT_MS,
    responseLimitBytes: EMAIL_RESPONSE_LIMIT_BYTES,
  } as const;

  if (env.MAIL_PROVIDER === "mailjet") {
    return {
      ...base,
      MAIL: {
        ...common,
        provider: "mailjet",
        apiSecret: env.MAIL_API_SECRET!,
      },
    };
  }

  return {
    ...base,
    MAIL: {
      ...common,
      provider: "brevo",
    },
  };
});

export function validateEnv(env: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

export function getEnv(envSource: NodeJS.ProcessEnv = process.env): Env {
  return validateEnv(envSource);
}
