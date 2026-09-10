"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  iconFor,
  type ConsoleLink,
  type ConsoleSection,
  type ConsoleUser,
} from "@/components/console-sections";
import { NavUser } from "@/components/nav-user";
import { Link, usePathname } from "@/i18n/navigation";

export function AppSidebar({
  sections,
  user,
  userLinks,
  homeHref,
  labels,
}: {
  sections: ConsoleSection[];
  user: ConsoleUser;
  userLinks: ConsoleLink[];
  homeHref: string;
  labels: { toggle: string; menu: string; logout: string };
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
                  const Icon = iconFor(link.href);
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

      <SidebarFooter>
        <NavUser
          user={user}
          links={userLinks}
          homeHref={homeHref}
          labels={{ menu: labels.menu, logout: labels.logout }}
        />
      </SidebarFooter>

      <SidebarRail aria-label={labels.toggle} title={labels.toggle} />
    </Sidebar>
  );
}
