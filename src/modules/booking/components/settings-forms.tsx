"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import type { SettingsActionState } from "@/modules/booking/actions/settings";
import {
  GRAVITY_FORM_FIELD_KEYS,
  STORED_SECRET_PLACEHOLDER,
} from "@/modules/booking/schema";

/** Mirrors the Prisma enum: a client module must not import from the server. */
type IntegrationProvider = "HOLDED" | "GRAVITY_FORMS" | "BOOKING_MAIL";

export interface CatalogueOption {
  id: string;
  name: string;
}

export interface HoldedCatalogueOptions {
  status: "ok" | "no_key" | "unauthorized" | "unavailable";
  services: CatalogueOption[];
  salesChannels: CatalogueOption[];
  paymentMethods: CatalogueOption[];
}

type SettingsAction = (
  previous: SettingsActionState,
  formData: FormData,
) => Promise<SettingsActionState>;

const IDLE: SettingsActionState = { status: "idle" };
const RATE_SKUS = ["dc30", "dc40", "dc60", "dc80", "pc30", "pc40", "pc60", "pc80"] as const;
/** The languages Holded can render a document in, named in their own tongue. */
const DOCUMENT_LANGUAGES: CatalogueOption[] = [
  { id: "ca", name: "Català" },
  { id: "es", name: "Español" },
  { id: "en", name: "English" },
  { id: "fr", name: "Français" },
];

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
 * Always a dropdown. A Holded identifier is an opaque 24-character string, so a
 * text field cannot be filled correctly from memory; when the catalogue is
 * missing the control is disabled and says why rather than inviting a guess.
 */
function Choice({
  name,
  label,
  options,
  defaultValue,
  required = false,
  emptyLabel,
  unavailableLabel,
  hint,
}: {
  name: string;
  label: string;
  options: CatalogueOption[];
  defaultValue?: string;
  required?: boolean;
  emptyLabel: string;
  unavailableLabel: string;
  hint?: string;
}) {
  const unavailable = options.length === 0;
  // A disabled control submits nothing, which would wipe a stored value, so the
  // current one rides along in a hidden field.
  const keepsCurrentValue = unavailable && Boolean(defaultValue);
  const hintId = hint ? `${name}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={name}
        name={unavailable ? undefined : name}
        required={required && !unavailable}
        disabled={unavailable}
        defaultValue={defaultValue ?? ""}
        aria-describedby={hintId}
        className="rounded-md border border-zinc-300 p-2 text-sm disabled:bg-zinc-100 disabled:text-zinc-500"
      >
        {unavailable ? (
          <option value={defaultValue ?? ""}>{defaultValue || unavailableLabel}</option>
        ) : (
          <>
            <option value="">{emptyLabel}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </>
        )}
      </select>
      {hint ? (
        <p id={hintId} className="text-xs text-zinc-600">
          {hint}
        </p>
      ) : null}
      {keepsCurrentValue ? (
        <input type="hidden" name={name} value={defaultValue} />
      ) : null}
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
  const unavailableLabel = t("holded.catalogueEmpty");
  const notice =
    catalogues.status === "ok" ? null : t(`holded.catalogue.${catalogues.status}`);

  return (
    <section aria-labelledby="holded-heading" className="flex flex-col gap-3">
      <h2 id="holded-heading" className="text-lg font-medium">
        {t("holded.title")}
      </h2>

      {notice ? (
        <p
          className={
            catalogues.status === "no_key"
              ? "text-sm text-zinc-600"
              : "text-sm text-amber-700"
          }
        >
          {notice}
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-3">
        <Field
          name="apiKey"
          type="password"
          label={t("holded.apiKey")}
          defaultValue={hasSecret ? STORED_SECRET_PLACEHOLDER : undefined}
          hint={hasSecret ? t("secretStored") : t("secretHint")}
        />
        <Choice
          name="salesChannelId"
          label={t("holded.salesChannelId")}
          options={catalogues.salesChannels}
          defaultValue={String(config?.salesChannelId ?? "")}
          emptyLabel={t("choose")}
          unavailableLabel={unavailableLabel}
          hint={t("holded.salesChannelHint")}
        />
        <Choice
          name="depositServiceId"
          label={t("holded.depositServiceId")}
          options={catalogues.services}
          defaultValue={String(config?.depositServiceId ?? "")}
          emptyLabel={t("choose")}
          unavailableLabel={unavailableLabel}
        />
        <Choice
          name="paymentMethodId"
          label={t("holded.paymentMethodId")}
          options={catalogues.paymentMethods}
          defaultValue={String(config?.paymentMethodId ?? "")}
          emptyLabel={t("choose")}
          unavailableLabel={unavailableLabel}
        />
        <Choice
          name="language"
          label={t("holded.language")}
          options={DOCUMENT_LANGUAGES}
          defaultValue={String(config?.language ?? "ca")}
          required
          emptyLabel={t("choose")}
          unavailableLabel={unavailableLabel}
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
                unavailableLabel={unavailableLabel}
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
          defaultValue={hasSecret ? STORED_SECRET_PLACEHOLDER : undefined}
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
          defaultValue={hasSecret ? STORED_SECRET_PLACEHOLDER : undefined}
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
