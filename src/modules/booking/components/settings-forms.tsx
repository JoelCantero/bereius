"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import type { SettingsActionState } from "@/modules/booking/actions/settings";
import { GRAVITY_FORM_FIELD_KEYS } from "@/modules/booking/schema";

/** Mirrors the Prisma enum: a client module must not import from the server. */
type IntegrationProvider = "HOLDED" | "GRAVITY_FORMS" | "BOOKING_MAIL";

export interface CatalogueOption {
  id: string;
  name: string;
}

export interface HoldedCatalogueOptions {
  services: CatalogueOption[];
  accounts: CatalogueOption[];
  paymentMethods: CatalogueOption[];
  mailTemplates: CatalogueOption[];
}

type SettingsAction = (
  previous: SettingsActionState,
  formData: FormData,
) => Promise<SettingsActionState>;

const IDLE: SettingsActionState = { status: "idle" };
const RATE_SKUS = ["dc30", "dc40", "dc60", "dc80", "pc30", "pc40", "pc60", "pc80"] as const;

function Feedback({ state }: { state: SettingsActionState }) {
  const t = useTranslations("Bookings.settings");
  const errors = useTranslations("Bookings.errors");

  if (state.status === "idle") return null;
  if (state.status === "error") {
    return (
      <p role="alert" className="text-sm text-red-700">
        {errors(state.reason === "storage_unavailable" ? "unknown" : state.reason)}
      </p>
    );
  }

  return (
    <p role="status" className="text-sm text-green-700">
      {state.status === "saved" ? t("saved") : t("verified")}
    </p>
  );
}

function Field({
  name,
  label,
  defaultValue,
  type = "text",
  required = false,
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string | number;
  type?: string;
  required?: boolean;
  hint?: string;
}) {
  const hintId = hint ? `${name}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        aria-describedby={hintId}
        autoComplete={type === "password" ? "new-password" : "off"}
        className="rounded-md border border-zinc-300 p-2 text-sm"
      />
      {hint ? (
        <p id={hintId} className="text-xs text-zinc-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A dropdown when the catalogue could be read from Holded, a text field when it
 * could not. Configuration must never depend on a list call succeeding.
 */
function Choice({
  name,
  label,
  options,
  defaultValue,
  required = false,
  emptyLabel,
}: {
  name: string;
  label: string;
  options: CatalogueOption[];
  defaultValue?: string;
  required?: boolean;
  emptyLabel: string;
}) {
  if (options.length === 0) {
    return (
      <Field name={name} label={label} defaultValue={defaultValue} required={required} />
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={name}
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="rounded-md border border-zinc-300 p-2 text-sm"
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function TestButton({
  provider,
  onTest,
}: {
  provider: IntegrationProvider;
  onTest: (provider: IntegrationProvider) => Promise<SettingsActionState>;
}) {
  const t = useTranslations("Bookings.settings");
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    async () => onTest(provider),
    IDLE,
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <Feedback state={state} />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-60"
      >
        {t("test")}
      </button>
    </form>
  );
}

export function HoldedSettingsForm({
  action,
  onTest,
  config,
  hasSecret,
  catalogues,
}: {
  action: SettingsAction;
  onTest: (provider: IntegrationProvider) => Promise<SettingsActionState>;
  config: Record<string, unknown> | null;
  hasSecret: boolean;
  catalogues: HoldedCatalogueOptions;
}) {
  const t = useTranslations("Bookings.settings");
  const [state, formAction, pending] = useActionState(action, IDLE);
  const services = (config?.serviceIdsBySku ?? {}) as Record<string, string>;

  return (
    <section aria-labelledby="holded-heading" className="flex flex-col gap-3">
      <h2 id="holded-heading" className="text-lg font-medium">
        {t("holded.title")}
      </h2>

      {hasSecret && catalogues.services.length === 0 ? (
        <p className="text-sm text-amber-700">{t("holded.cataloguesUnavailable")}</p>
      ) : null}
      {!hasSecret ? (
        <p className="text-sm text-zinc-600">{t("holded.keyFirst")}</p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-3">
        <Field
          name="apiKey"
          type="password"
          label={t("holded.apiKey")}
          hint={hasSecret ? t("secretStored") : t("secretHint")}
        />
        <Choice
          name="accountingAccountId"
          label={t("holded.accountingAccountId")}
          options={catalogues.accounts}
          defaultValue={String(config?.accountingAccountId ?? "")}
          emptyLabel={t("choose")}
        />
        <Choice
          name="depositServiceId"
          label={t("holded.depositServiceId")}
          options={catalogues.services}
          defaultValue={String(config?.depositServiceId ?? "")}
          emptyLabel={t("choose")}
        />
        <Choice
          name="mailTemplateId"
          label={t("holded.mailTemplateId")}
          options={catalogues.mailTemplates}
          defaultValue={String(config?.mailTemplateId ?? "")}
          emptyLabel={t("choose")}
        />
        <Choice
          name="paymentMethodId"
          label={t("holded.paymentMethodId")}
          options={catalogues.paymentMethods}
          defaultValue={String(config?.paymentMethodId ?? "")}
          emptyLabel={t("choose")}
        />
        <Field
          name="language"
          label={t("holded.language")}
          required
          defaultValue={String(config?.language ?? "ca")}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t("holded.services")}</legend>
          <div className="grid grid-cols-2 gap-3">
            {RATE_SKUS.map((sku) => (
              <Choice
                key={sku}
                name={`service.${sku}`}
                label={sku}
                options={catalogues.services}
                defaultValue={services[sku] ?? ""}
                emptyLabel={t("choose")}
              />
            ))}
          </div>
        </fieldset>

        <Feedback state={state} />

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t("save")}
        </button>
      </form>

      <TestButton provider="HOLDED" onTest={onTest} />
    </section>
  );
}

export function GravityFormsSettingsForm({
  action,
  onTest,
  config,
  hasSecret,
  defaultFieldMap,
}: {
  action: SettingsAction;
  onTest: (provider: IntegrationProvider) => Promise<SettingsActionState>;
  config: Record<string, unknown> | null;
  hasSecret: boolean;
  defaultFieldMap: Record<string, string>;
}) {
  const t = useTranslations("Bookings.settings");
  const [state, formAction, pending] = useActionState(action, IDLE);
  const fieldMap = {
    ...defaultFieldMap,
    ...((config?.fieldMap ?? {}) as Record<string, string>),
  };

  return (
    <section aria-labelledby="gravity-heading" className="flex flex-col gap-3">
      <h2 id="gravity-heading" className="text-lg font-medium">
        {t("gravityForms.title")}
      </h2>

      <form action={formAction} className="flex flex-col gap-3">
        <Field
          name="apiUrl"
          label={t("gravityForms.apiUrl")}
          required
          defaultValue={String(config?.apiUrl ?? "")}
        />
        <Field
          name="formId"
          label={t("gravityForms.formId")}
          required
          defaultValue={String(config?.formId ?? "")}
        />
        <Field
          name="consumerKey"
          label={t("gravityForms.consumerKey")}
          required
          defaultValue={String(config?.consumerKey ?? "")}
        />
        <Field
          name="consumerSecret"
          type="password"
          label={t("gravityForms.consumerSecret")}
          hint={hasSecret ? t("secretStored") : t("secretHint")}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t("gravityForms.fields")}</legend>
          <p className="text-xs text-zinc-600">{t("gravityForms.fieldsHint")}</p>
          <div className="grid grid-cols-2 gap-3">
            {GRAVITY_FORM_FIELD_KEYS.map((key) => (
              <Field
                key={key}
                name={`field.${key}`}
                label={t(`fieldLabels.${key}`)}
                required
                defaultValue={fieldMap[key] ?? ""}
              />
            ))}
          </div>
        </fieldset>

        <Feedback state={state} />

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t("save")}
        </button>
      </form>

      <TestButton provider="GRAVITY_FORMS" onTest={onTest} />
    </section>
  );
}

export function BookingMailSettingsForm({
  action,
  onTest,
  config,
  hasSecret,
}: {
  action: SettingsAction;
  onTest: (provider: IntegrationProvider) => Promise<SettingsActionState>;
  config: Record<string, unknown> | null;
  hasSecret: boolean;
}) {
  const t = useTranslations("Bookings.settings");
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <section aria-labelledby="mail-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="mail-heading" className="text-lg font-medium">
          {t("mail.title")}
        </h2>
        <p className="text-sm text-zinc-600">{t("mail.description")}</p>
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        <Field
          name="host"
          label={t("mail.host")}
          required
          defaultValue={String(config?.host ?? "")}
        />
        <Field
          name="port"
          type="number"
          label={t("mail.port")}
          required
          defaultValue={String(config?.port ?? 587)}
        />

        <div className="flex items-center gap-2">
          <input
            id="secure"
            name="secure"
            type="checkbox"
            value="true"
            defaultChecked={config?.secure === true}
          />
          <label htmlFor="secure" className="text-sm font-medium">
            {t("mail.secure")}
          </label>
        </div>

        <Field
          name="username"
          label={t("mail.username")}
          required
          defaultValue={String(config?.username ?? "")}
        />
        <Field
          name="fromEmail"
          type="email"
          label={t("mail.fromEmail")}
          required
          defaultValue={String(config?.fromEmail ?? "")}
        />
        <Field
          name="password"
          type="password"
          label={t("mail.password")}
          hint={hasSecret ? t("secretStored") : t("secretHint")}
        />

        <Feedback state={state} />

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t("save")}
        </button>
      </form>

      <TestButton provider="BOOKING_MAIL" onTest={onTest} />
    </section>
  );
}
