"use client";

import {
  CalendarCheck,
  FileText,
  LayoutGrid,
  type LucideIcon,
  Plug,
  ScrollText,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Link, usePathname } from "@/i18n/navigation";

export type ConsoleSectionKey = "bookings" | "account" | "legal";

export interface ConsoleLink {
  href: string;
  label: string;
  description: string;
}

export interface ConsoleSection {
  key: ConsoleSectionKey;
  label: string;
  links: ConsoleLink[];
}

/** Kept beside the route so the server can pass plain, serialisable sections. */
const ICONS: Record<string, LucideIcon> = {
  "/bookings": CalendarCheck,
  "/bookings/settings": Plug,
  "/account": UserRound,
  "/account/security": ShieldCheck,
  "/account/data": FileText,
  "/terms": ScrollText,
  "/privacy": ScrollText,
};

export function AppSidebar({
  sections,
  toggleLabel,
}: {
  sections: ConsoleSection[];
  toggleLabel: string;
}) {
  const pathname = usePathname();

  return (
    <Sidebar
      collapsible="icon"
      className="top-(--sidebar-top) h-[calc(100svh-var(--sidebar-top))]"
    >
      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup
            key={section.key}
            role="group"
            aria-labelledby={`sidebar-${section.key}`}
          >
            <SidebarGroupLabel id={`sidebar-${section.key}`}>
              {section.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.links.map((link) => {
                  const Icon = ICONS[link.href] ?? LayoutGrid;
                  const active = pathname === link.href;

                  return (
                    <SidebarMenuItem key={link.href}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={link.label}
                        render={
                          <Link
                            href={link.href}
                            aria-current={active ? "page" : undefined}
                          />
                        }
                      >
                        <Icon aria-hidden="true" />
                        <span>{link.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarRail aria-label={toggleLabel} title={toggleLabel} />
    </Sidebar>
  );
}
