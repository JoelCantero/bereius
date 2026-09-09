import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { noIndexMetadata } from "@/lib/seo";
import {
  saveBookingMailSettings,
  saveGravityFormsSettings,
  saveHoldedSettings,
  testIntegration,
} from "@/modules/booking/actions/settings";
import { AuthorizationError, requireBookingActor } from "@/modules/booking/authorization";
import {
  BookingMailSettingsForm,
  GravityFormsSettingsForm,
  HoldedSettingsForm,
} from "@/modules/booking/components/settings-forms";
import { DEFAULT_GRAVITY_FORM_FIELDS } from "@/modules/booking/schema";
import {
  listIntegrationStatus,
  readHoldedCatalogues,
  readIntegrationConfig,
} from "@/modules/booking/services/settings";
import { getLoginPathForLocale, parseLoginLocale } from "@/modules/login/schema";

interface SettingsPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: SettingsPageProps): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Bookings.settings" });

  return noIndexMetadata({ title: t("title"), description: t("description") });
}

export default async function BookingSettingsPage({ params }: SettingsPageProps) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);

  try {
    await requireBookingActor("ADMINISTRATOR");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.code === "forbidden") redirect("/bookings");
      redirect(
        `${getLoginPathForLocale(locale)}?callbackUrl=${encodeURIComponent("/bookings/settings")}`,
      );
    }
    throw error;
  }

  const t = await getTranslations({ locale, namespace: "Bookings.settings" });
  const queue = await getTranslations({ locale, namespace: "Bookings.queue" });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  const [statuses, holded, gravityForms, mail, catalogues] = await Promise.all([
    listIntegrationStatus(),
    readIntegrationConfig("HOLDED"),
    readIntegrationConfig("GRAVITY_FORMS"),
    readIntegrationConfig("BOOKING_MAIL"),
    readHoldedCatalogues(),
  ]);

  const statusFor = (provider: "HOLDED" | "GRAVITY_FORMS" | "BOOKING_MAIL") =>
    statuses.find((status) => status.provider === provider);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 p-6">
      <div className="flex flex-col gap-2">
        <Link href="/bookings" className="text-sm underline">
          {queue("title")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-zinc-600">{t("description")}</p>
      </div>

      <ul className="flex flex-col gap-1 text-sm">
        {statuses.map((status) => (
          <li key={status.provider}>
            <span className="font-medium">{t(`providers.${status.provider}`)}</span>{" "}
            {status.configured ? t("configured") : t("notConfigured")}
            {" · "}
            {status.verifiedAt
              ? t("verifiedAt", { date: dateFormat.format(status.verifiedAt) })
              : t("neverVerified")}
          </li>
        ))}
      </ul>

      <HoldedSettingsForm
        action={saveHoldedSettings}
        onTest={testIntegration}
        config={holded}
        hasSecret={statusFor("HOLDED")?.hasSecret ?? false}
        catalogues={catalogues}
      />

      <GravityFormsSettingsForm
        action={saveGravityFormsSettings}
        onTest={testIntegration}
        config={gravityForms}
        hasSecret={statusFor("GRAVITY_FORMS")?.hasSecret ?? false}
        defaultFieldMap={DEFAULT_GRAVITY_FORM_FIELDS}
      />

      <BookingMailSettingsForm
        action={saveBookingMailSettings}
        onTest={testIntegration}
        config={mail}
        hasSecret={statusFor("BOOKING_MAIL")?.hasSecret ?? false}
      />
    </main>
  );
}
