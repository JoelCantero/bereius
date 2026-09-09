import "server-only";

import { getServerSession } from "next-auth";
import { getTranslations } from "next-intl/server";

import type {
  ConsoleLink,
  ConsoleSection,
  ConsoleUser,
} from "@/components/console-sections";
import { getPathname } from "@/i18n/navigation";
import { authOptions } from "@/lib/auth";
import { getProfileInitials } from "@/modules/account/initials";
import { requireBookingActor } from "@/modules/booking/authorization";

export interface ConsoleNavigation {
  user: ConsoleUser;
  sections: ConsoleSection[];
  userLinks: ConsoleLink[];
  homeHref: string;
  labels: { toggle: string; menu: string; logout: string };
}

/**
 * Null when nobody is signed in, so a public page renders without the console.
 * The role decides what the navigation offers; the pages enforce it again.
 */
export async function buildConsoleNavigation(
  locale: "en" | "es" | "ca",
): Promise<ConsoleNavigation | null> {
  const actor = await requireBookingActor().catch(() => null);
  if (!actor) return null;

  const t = await getTranslations({ locale, namespace: "Console" });
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? "";

  const userLinks: ConsoleLink[] = [
    {
      href: "/account",
      label: t("links.profile.label"),
      description: t("links.profile.description"),
    },
    {
      href: "/account/security",
      label: t("links.security.label"),
      description: t("links.security.description"),
    },
    {
      href: "/account/data",
      label: t("links.data.label"),
      description: t("links.data.description"),
    },
    ...(actor.role === "ADMINISTRATOR"
      ? [
          {
            href: "/bookings/settings",
            label: t("links.integrations.label"),
            description: t("links.integrations.description"),
          },
        ]
      : []),
  ];

  return {
    user: {
      name: session?.user?.name ?? email,
      email,
      image: session?.user?.image ?? null,
      initials: getProfileInitials({ name: session?.user?.name ?? null, email }),
    },
    sections: [
      {
        key: "bookings",
        label: t("sections.bookings"),
        links: [
          {
            href: "/bookings",
            label: t("links.queue.label"),
            description: t("links.queue.description"),
          },
        ],
      },
    ],
    userLinks,
    homeHref: getPathname({ href: "/", locale }),
    labels: {
      toggle: t("toggleSidebar"),
      menu: t("userMenu"),
      logout: t("logout"),
    },
  };
}
