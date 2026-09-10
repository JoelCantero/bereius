import type { BookingState } from "@/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";

/**
 * Colour is a shortcut, never the message: the label carries the meaning for
 * anyone who cannot rely on hue.
 */
const TONES: Record<BookingState, string> = {
  IN_REVIEW: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100",
  AWAITING_PAYMENT: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  CONFIRMED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  INVOICED: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  COMPLETED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  REJECTED: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  EXPIRED: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export function BookingStateBadge({
  state,
  label,
}: {
  state: BookingState;
  label: string;
}) {
  return <Badge className={TONES[state]}>{label}</Badge>;
}
