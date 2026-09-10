"use client";

import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import type {
  ConsoleLink,
  ConsoleSection,
  ConsoleUser,
} from "@/components/console-sections";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

export function ConsoleShell({
  sections,
  user,
  userLinks,
  homeHref,
  labels,
  children,
}: {
  sections: ConsoleSection[];
  user: ConsoleUser;
  userLinks: ConsoleLink[];
  homeHref: string;
  labels: { toggle: string; menu: string; logout: string };
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      {/* The page already sits below a 4rem header, which the fixed sidebar
          would otherwise cover. */}
      <SidebarProvider className="min-h-0 flex-1 [--sidebar-top:4rem]">
        <AppSidebar
          sections={sections}
          user={user}
          userLinks={userLinks}
          homeHref={homeHref}
          labels={labels}
        />
        <SidebarInset className="min-w-0 bg-transparent">
          <div className="flex items-center gap-2 px-4 pt-4">
            <SidebarTrigger aria-label={labels.toggle} />
          </div>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
