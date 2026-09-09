"use client";

import type { ReactNode } from "react";

import { AppSidebar, type ConsoleSection } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

export function ConsoleShell({
  sections,
  toggleLabel,
  children,
}: {
  sections: ConsoleSection[];
  toggleLabel: string;
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      {/* The page already sits below a 4rem header, which the fixed sidebar
          would otherwise cover. */}
      <SidebarProvider className="min-h-0 flex-1 [--sidebar-top:4rem]">
        <AppSidebar sections={sections} toggleLabel={toggleLabel} />
        <SidebarInset className="min-w-0 bg-transparent">
          <div className="flex items-center gap-2 px-4 pt-4">
            <SidebarTrigger aria-label={toggleLabel} />
          </div>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
