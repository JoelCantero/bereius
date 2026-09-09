"use client";

import { Check, Globe, LogIn, Moon, Sun, UserPlus } from "lucide-react";
import { useTheme } from "next-themes";

import { getPathname, Link, usePathname } from "@/i18n/navigation";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface AppNavigationProps {
  authenticated: boolean;
  locale: "en" | "es" | "ca";
  labels: {
    ariaLabel: string;
    login: string;
    signup: string;
    toggleTheme: string;
    language: string;
  };
}

const languages = [
  { locale: "ca", label: "CA" },
  { locale: "en", label: "ENG" },
  { locale: "es", label: "ES" },
] as const;

export function AppNavigation({
  authenticated,
  locale,
  labels,
}: AppNavigationProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const pathname = usePathname();
  const currentLanguage = languages.find((language) => language.locale === locale);

  return (
    <NavigationMenu
      aria-label={labels.ariaLabel}
      className="min-w-0 max-w-full justify-end"
    >
      <NavigationMenuList className="w-auto flex-nowrap justify-end">
        {/* Signed-in users reach their account through the console sidebar. */}
        {authenticated ? null : (
          <>
            <NavigationMenuItem>
              <NavigationMenuLink
                aria-label={labels.login}
                className="size-9 justify-center p-0 min-[30rem]:h-auto min-[30rem]:w-auto min-[30rem]:justify-start min-[30rem]:p-2"
                render={<Link href="/login" />}
              >
                <LogIn aria-hidden="true" />
                <span className="sr-only min-[30rem]:not-sr-only">{labels.login}</span>
              </NavigationMenuLink>
            </NavigationMenuItem>
            <NavigationMenuItem>
              <NavigationMenuLink
                aria-label={labels.signup}
                className="size-9 justify-center p-0 min-[30rem]:h-auto min-[30rem]:w-auto min-[30rem]:justify-start min-[30rem]:p-2"
                render={<Link href="/signup" />}
              >
                <UserPlus aria-hidden="true" />
                <span className="sr-only min-[30rem]:not-sr-only">{labels.signup}</span>
              </NavigationMenuLink>
            </NavigationMenuItem>
          </>
        )}
        <li className="hidden h-9 items-center px-1 min-[30rem]:flex" aria-hidden="true">
          <span className="flex h-5">
            <Separator orientation="vertical" />
          </span>
        </li>
        <NavigationMenuItem>
          <NavigationMenuTrigger aria-label={labels.language}>
            <Globe className="mr-1 size-4" aria-hidden="true" />
            {currentLanguage?.label}
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-36">
              <li>
                {languages.map((language) => {
                  const isCurrent = language.locale === locale;
                  const localizedPath =
                    language.locale === "en"
                      ? `/en${pathname === "/" ? "" : pathname}`
                      : getPathname({ href: pathname, locale: language.locale });

                  return (
                    <NavigationMenuLink
                      key={language.locale}
                      render={
                        <a
                          href={localizedPath}
                          className="flex-row items-center gap-2"
                          aria-current={isCurrent ? "page" : undefined}
                          onClickCapture={(event) => {
                            event.preventDefault();
                            window.location.assign(localizedPath);
                          }}
                        />
                      }
                    >
                      <Check
                        className={cn("size-4", !isCurrent && "invisible")}
                        aria-hidden="true"
                      />
                      {language.label}
                    </NavigationMenuLink>
                  );
                })}
              </li>
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink
            className="relative size-9 justify-center px-0"
            render={
              <button
                type="button"
                aria-label={labels.toggleTheme}
                title={labels.toggleTheme}
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              />
            }
          >
            <Sun className="size-4 scale-100 rotate-0 dark:scale-0 dark:-rotate-90" />
            <Moon className="absolute inset-0 m-auto size-4 scale-0 rotate-90 dark:scale-100 dark:rotate-0" />
          </NavigationMenuLink>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}