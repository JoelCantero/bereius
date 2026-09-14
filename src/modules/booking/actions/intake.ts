"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import { GravityFormsError } from "@/lib/gravity-forms/client";
import { logger } from "@/lib/logger";
import {
  AuthorizationError,
  requireBookingActor,
} from "@/modules/booking/authorization";
import { runIntake } from "@/modules/booking/services/intake";
import { IntegrationSettingsError } from "@/modules/booking/services/settings";

type IntakeErrorReason =
  | "unauthenticated"
  | "forbidden"
  | "invalid"
  | "authentication"
  | "connection"
  | "not_found"
  | "rejected"
  | "unknown";

export type IntakeActionState =
  | { status: "idle" }
  | { status: "done"; created: number; skipped: number; rejected: number }
  | { status: "error"; reason: IntakeErrorReason };

function toErrorState(error: unknown): IntakeActionState {
  if (error instanceof AuthorizationError) {
    return { status: "error", reason: error.code };
  }
  if (error instanceof IntegrationSettingsError) {
    return { status: "error", reason: "invalid" };
  }
  if (error instanceof GravityFormsError) {
    if (error.code === "unauthorized") {
      return { status: "error", reason: "authentication" };
    }
    if (error.code === "not_found") {
      return { status: "error", reason: "not_found" };
    }
    if (error.code === "unavailable" || error.code === "rate_limited") {
      return { status: "error", reason: "connection" };
    }
    return { status: "error", reason: "rejected" };
  }
  return { status: "error", reason: "unknown" };
}

export async function refreshIntakeAction(): Promise<IntakeActionState> {
  try {
    await requireBookingActor();
    const summary = await runIntake();
    revalidatePath("/bookings");

    return {
      status: "done",
      created: summary.created,
      skipped: summary.skipped,
      rejected: summary.rejected,
    };
  } catch (error) {
    const state = toErrorState(error);
    logger.warn(
      {
        event: "booking_intake_manual_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "manual booking intake failed",
    );
    return state;
  }
}