import "server-only";

import { z } from "zod";

import type { IntegrationProvider } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import {
  isSecretStorageAvailable,
  openSecret,
  sealSecret,
} from "@/lib/booking/secrets";
import { createHoldedClient, type HoldedOption } from "@/lib/holded/client";
import {
  DEFAULT_GRAVITY_FORM_FIELDS,
  gravityFormFieldMapSchema,
} from "@/modules/booking/schema";

const gravityFormsConfigSchema = z
  .object({
    apiUrl: z
      .url()
      .refine((value) => new URL(value).protocol === "https:", {
        message: "apiUrl must be HTTPS",
      }),
    formId: z.string().regex(/^\d+$/u),
    consumerKey: z.string().min(1),
    // Configurable so a rebuilt form does not need a code change.
    fieldMap: gravityFormFieldMapSchema.default(DEFAULT_GRAVITY_FORM_FIELDS),
  })
  .strict();

const holdedConfigSchema = z
  .object({
    // Optional so the API key can be saved first and the identifiers chosen
    // afterwards, once they can be offered as dropdowns. Quoting refuses to run
    // until they are present.
    accountingAccountId: z.string().min(1).optional(),
    depositServiceId: z.string().min(1).optional(),
    mailTemplateId: z.string().min(1).optional(),
    paymentMethodId: z.string().min(1).optional(),
    language: z.string().min(2).max(5).default("ca"),
    /** Service identifier per rate SKU, e.g. `dc40` or `pc80`. */
    serviceIdsBySku: z.record(
      z.string().regex(/^(?:dc|pc)(?:30|40|60|80)$/u),
      z.string().min(1),
    ),
  })
  .strict();

const bookingMailConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    secure: z.boolean(),
    username: z.string().min(1),
    fromEmail: z.email(),
  })
  .strict();

const CONFIG_SCHEMAS = {
  GRAVITY_FORMS: gravityFormsConfigSchema,
  HOLDED: holdedConfigSchema,
  BOOKING_MAIL: bookingMailConfigSchema,
} as const satisfies Record<IntegrationProvider, z.ZodType>;

export type GravityFormsConfig = z.infer<typeof gravityFormsConfigSchema>;
export type HoldedConfig = z.infer<typeof holdedConfigSchema>;
export type BookingMailConfig = z.infer<typeof bookingMailConfigSchema>;

export interface IntegrationStatus {
  provider: IntegrationProvider;
  configured: boolean;
  /** Never the credential itself: only whether one is stored. */
  hasSecret: boolean;
  verifiedAt: Date | null;
  updatedAt: Date | null;
}

export class IntegrationSettingsError extends Error {
  constructor(
    readonly code: "not_configured" | "invalid_config" | "storage_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "IntegrationSettingsError";
  }
}

/** Safe for the settings screen: reports presence, never values. */
export async function listIntegrationStatus(): Promise<IntegrationStatus[]> {
  const rows = await db.integrationSettings.findMany({
    select: {
      provider: true,
      secretCiphertext: true,
      verifiedAt: true,
      updatedAt: true,
    },
  });
  const byProvider = new Map(rows.map((row) => [row.provider, row]));

  return (Object.keys(CONFIG_SCHEMAS) as IntegrationProvider[]).map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      configured: row !== undefined && row.secretCiphertext !== null,
      hasSecret: row?.secretCiphertext != null,
      verifiedAt: row?.verifiedAt ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export interface SaveIntegrationCommand<P extends IntegrationProvider> {
  provider: P;
  config: unknown;
  /** Omitted to keep the stored credential, so editing a host never clears it. */
  secret?: string;
  updatedById: string | null;
}

export async function saveIntegrationSettings<P extends IntegrationProvider>(
  command: SaveIntegrationCommand<P>,
): Promise<void> {
  if (!isSecretStorageAvailable()) {
    throw new IntegrationSettingsError(
      "storage_unavailable",
      "BOOKING_SECRET_KEY is not configured, so credentials cannot be stored",
    );
  }

  const parsed = CONFIG_SCHEMAS[command.provider].safeParse(command.config);
  if (!parsed.success) {
    throw new IntegrationSettingsError(
      "invalid_config",
      `Invalid configuration for ${command.provider}`,
    );
  }

  const existing = await db.integrationSettings.findUnique({
    where: { provider: command.provider },
    select: { secretCiphertext: true },
  });

  if (command.secret === undefined && existing?.secretCiphertext == null) {
    throw new IntegrationSettingsError(
      "invalid_config",
      `A credential is required the first time ${command.provider} is configured`,
    );
  }

  const sealed = command.secret === undefined ? null : sealSecret(command.secret);

  await db.integrationSettings.upsert({
    where: { provider: command.provider },
    create: {
      provider: command.provider,
      config: parsed.data as object,
      secretCiphertext: sealed?.ciphertext ?? null,
      secretIv: sealed?.iv ?? null,
      secretAuthTag: sealed?.authTag ?? null,
      updatedById: command.updatedById,
    },
    update: {
      config: parsed.data as object,
      // A saved credential is replaced, never cleared by an unrelated edit.
      ...(sealed
        ? {
            secretCiphertext: sealed.ciphertext,
            secretIv: sealed.iv,
            secretAuthTag: sealed.authTag,
            verifiedAt: null,
          }
        : {}),
      updatedById: command.updatedById,
    },
  });
}

export async function markIntegrationVerified(
  provider: IntegrationProvider,
): Promise<void> {
  await db.integrationSettings.update({
    where: { provider },
    data: { verifiedAt: new Date() },
  });
}

export interface ResolvedIntegration<TConfig> {
  config: TConfig;
  secret: string;
}

/** Non-secret configuration for the settings screen, safe to render. */
export async function readIntegrationConfig(
  provider: IntegrationProvider,
): Promise<Record<string, unknown> | null> {
  const row = await db.integrationSettings.findUnique({
    where: { provider },
    select: { config: true },
  });

  return row?.config && typeof row.config === "object"
    ? (row.config as Record<string, unknown>)
    : null;
}

export interface HoldedCatalogues {
  services: HoldedOption[];
  accounts: HoldedOption[];
  paymentMethods: HoldedOption[];
  mailTemplates: HoldedOption[];
}

const EMPTY_CATALOGUES: HoldedCatalogues = {
  services: [],
  accounts: [],
  paymentMethods: [],
  mailTemplates: [],
};

/**
 * Loads what the settings dropdowns need once a Holded key is stored.
 *
 * Every list is best-effort: an unconfigured or unreachable Holded leaves the
 * screen usable with plain text fields rather than blocking configuration.
 */
export async function readHoldedCatalogues(): Promise<HoldedCatalogues> {
  let client;
  try {
    const { secret } = await resolveIntegration("HOLDED");
    client = createHoldedClient(secret);
  } catch {
    return EMPTY_CATALOGUES;
  }

  const [services, accounts, paymentMethods, mailTemplates] = await Promise.all([
    client.listServices().catch(() => []),
    client.listOptions("expensesaccounts"),
    client.listOptions("paymentmethods"),
    client.listOptions("mailtemplates"),
  ]);

  return { services, accounts, paymentMethods, mailTemplates };
}

/**
 * Server-side only. Returns the decrypted credential, so the result must never
 * reach a component, a response body or a log line.
 */
export async function resolveIntegration<P extends IntegrationProvider>(
  provider: P,
): Promise<ResolvedIntegration<z.infer<(typeof CONFIG_SCHEMAS)[P]>>> {
  const row = await db.integrationSettings.findUnique({
    where: { provider },
    select: {
      config: true,
      secretCiphertext: true,
      secretIv: true,
      secretAuthTag: true,
    },
  });

  if (!row || !row.secretCiphertext || !row.secretIv || !row.secretAuthTag) {
    throw new IntegrationSettingsError(
      "not_configured",
      `${provider} is not configured`,
    );
  }

  const parsed = CONFIG_SCHEMAS[provider].safeParse(row.config);
  if (!parsed.success) {
    throw new IntegrationSettingsError(
      "invalid_config",
      `Stored configuration for ${provider} no longer matches its schema`,
    );
  }

  return {
    config: parsed.data as z.infer<(typeof CONFIG_SCHEMAS)[P]>,
    secret: openSecret({
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      authTag: row.secretAuthTag,
    }),
  };
}
