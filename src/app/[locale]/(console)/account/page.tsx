import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { authOptions } from "@/lib/auth";
import { noIndexMetadata } from "@/lib/seo";
import { updateProfile } from "@/modules/account/actions/update-profile";
import { AccountNavigation } from "@/modules/account/components/account-navigation";
import { ProfileForm } from "@/modules/account/components/profile-form";
import { getSessionUserId } from "@/modules/account/session";
import { getCurrentUserProfile } from "@/modules/account/service";
import {
  getAccountPathForLocale,
  getLoginPathForLocale,
  parseLoginLocale,
} from "@/modules/login/schema";

interface AccountPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: AccountPageProps): Promise<Metadata> {
  const locale = parseLoginLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Account.page.metadata" });

  return noIndexMetadata({
    title: t("title"),
    description: t("description"),
  });
}

export default async function AccountPage({ params }: AccountPageProps) {
  const locale = parseLoginLocale((await params).locale);
  setRequestLocale(locale);
  const session = await getServerSession(authOptions);
  const sessionUserId = getSessionUserId(session);

  if (!sessionUserId) {
    const callbackPath = getAccountPathForLocale(locale);
    redirect(`${getLoginPathForLocale(locale)}?callbackUrl=${encodeURIComponent(callbackPath)}`);
  }

  const t = await getTranslations({ locale, namespace: "Account" });
  const profile = await getCurrentUserProfile(sessionUserId);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <section className="grid min-w-0 gap-6 md:grid-cols-[minmax(11rem,13rem)_minmax(0,1fr)] md:items-start md:gap-8">
        <AccountNavigation
          active="profile"
          messages={{
            ariaLabel: t("navigation.profileAriaLabel"),
            profile: t("navigation.profile"),
            dataAndPrivacy: t("navigation.dataAndPrivacy"),
            security: t("navigation.security"),
          }}
        />

        <ProfileForm
          locale={locale}
          initialProfile={profile}
          action={updateProfile}
          messages={{
            profileHeading: t("heading.title"),
            profileDescription: t("heading.description"),
            avatarLabel: t("avatar.label"),
            avatarImageAlt: t("avatar.imageAlt"),
            nameLabel: t("fields.name.label"),
            nameDescription: t("fields.name.description"),
            emailLabel: t("fields.email.label"),
            emailDescription: t("fields.email.description"),
            saveIdle: t("actions.saveIdle"),
            savePending: t("actions.savePending"),
            pendingAnnouncement: t("actions.pendingAnnouncement"),
            saved: t("states.saved"),
            saveFailed: t("states.saveFailed"),
            required: t("validation.required"),
            tooLong: t("validation.tooLong"),
            invalidCharacters: t("validation.invalidCharacters"),
            invalidSubmission: t("validation.invalidSubmission"),
          }}
        />
      </section>
    </main>
  );
}