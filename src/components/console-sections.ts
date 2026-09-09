import {
  CalendarCheck,
  FileSignature,
  FileText,
  LayoutGrid,
  type LucideIcon,
  Plug,
  ShieldCheck,
  UserRound,
} from "lucide-react";

export interface ConsoleLink {
  href: string;
  label: string;
  description: string;
}

export interface ConsoleSection {
  key: string;
  label: string;
  links: ConsoleLink[];
}

export interface ConsoleUser {
  name: string;
  email: string;
  image: string | null;
  initials: string;
}

/** Resolved from the route, because a component cannot cross the server boundary. */
const ICONS: Record<string, LucideIcon> = {
  "/bookings": CalendarCheck,
  "/contracts": FileSignature,
  "/bookings/settings": Plug,
  "/account": UserRound,
  "/account/security": ShieldCheck,
  "/account/data": FileText,
};

export function iconFor(href: string): LucideIcon {
  return ICONS[href] ?? LayoutGrid;
}
