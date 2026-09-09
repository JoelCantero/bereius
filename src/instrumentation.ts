import { getEnv } from "@/lib/env";

export function register(): void {
  try {
    getEnv();
  } catch (error) {
    if (
      process.env.NEXT_RUNTIME === "nodejs" &&
      process.env.NODE_ENV === "production"
    ) {
      const message =
        error instanceof Error
          ? error.message
          : "Invalid environment configuration";

      process.stderr.write(`${message}\n`);
      process.exit(1);
    }

    throw error;
  }

  // Node runtime only: the Edge runtime has no database access and no timers
  // that outlive a request.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.BOOKING_SCHEDULER !== "true") return;

  // Deliberately not awaited: environment validation above must stay
  // synchronous so a malformed configuration fails before readiness.
  void import("@/modules/booking/services/scheduler")
    .then(({ registerScheduler }) => registerScheduler())
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Unknown scheduler failure";
      process.stderr.write(`Booking scheduler failed to start: ${message}\n`);
    });
}