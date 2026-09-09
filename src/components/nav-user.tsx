"use client";

import { useTransition } from "react";
import { ChevronsUpDown, LogOut } from "lucide-react";
import { signOut } from "next-auth/react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Link, usePathname } from "@/i18n/navigation";
import {
  iconFor,
  type ConsoleLink,
  type ConsoleUser,
} from "@/components/console-sections";

export function NavUser({
  user,
  links,
  labels,
  homeHref,
}: {
  user: ConsoleUser;
  links: ConsoleLink[];
  labels: { menu: string; logout: string };
  homeHref: string;
}) {
  const { isMobile } = useSidebar();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                aria-label={labels.menu}
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg text-xs">
                {user.initials}
              </AvatarFallback>
              {user.image ? (
                <AvatarImage
                  className="absolute inset-0"
                  src={user.image}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : null}
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-sidebar-foreground/70">
                {user.email}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
          >
            {/* Base UI requires a group around a label. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1.5 py-1.5 text-left text-sm">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg text-xs">
                      {user.initials}
                    </AvatarFallback>
                    {user.image ? (
                      <AvatarImage
                        className="absolute inset-0"
                        src={user.image}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                    ) : null}
                  </Avatar>
                  <div className="grid flex-1 leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user.email}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>

            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {links.map((link) => {
                const Icon = iconFor(link.href);
                const active = pathname === link.href;

                return (
                  <DropdownMenuItem
                    key={link.href}
                    render={
                      <Link
                        href={link.href}
                        className="flex-row items-center"
                        aria-current={active ? "page" : undefined}
                      />
                    }
                  >
                    <Icon aria-hidden="true" />
                    {link.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>

            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={isPending}
              onClick={() => {
                startTransition(() => {
                  void signOut({ callbackUrl: homeHref });
                });
              }}
            >
              <LogOut aria-hidden="true" />
              {labels.logout}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
