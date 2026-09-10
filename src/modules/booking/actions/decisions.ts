"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logger } from "@/lib/logger";
import {
  AuthorizationError,
  requireBookingActor,
} from "@/modules/booking/authorization";
import {
  approveBooking,
  cancelBooking,
  PaymentError,
  recordPayment,
  rejectBooking,
} from "@/modules/booking/services/decisions";
import { BookingTransitionError } from "@/modules/booking/services/lifecycle";

export type DecisionActionState =
  | { status: "idle" }
  | { status: "done" }
  | {
      status: "error";
      reason:
        | "unauthenticated"
        | "forbidden"
        | "invalid"
        | "state_changed"
        | "reason_required"
        | "amount_mismatch"
        | "unknown";
    };

const decisionSchema = z.object({
  bookingRequestId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
  expectedFrom: z.enum(["IN_REVIEW"]).optional(),
});

const paymentSchema = z.object({
  bookingRequestId: z.string().min(1),
  // Entered in euros; converted to cents here so no float reaches the domain.
  amount: z.coerce.number().positive().max(1_000_000),
  receivedAt: z.coerce.date(),
  reference: z.string().trim().max(140).optional(),
});

function toErrorState(error: unknown): DecisionActionState {
  if (error instanceof AuthorizationError) {
    return { status: "error", reason: error.code };
  }
  if (error instanceof BookingTransitionError) {
    if (error.code === "reason_required") {
      return { status: "error", reason: "reason_required" };
    }
    return { status: "error", reason: "state_changed" };
  }
  if (error instanceof PaymentError) {
    return {
      status: "error",
      reason: error.code === "amount_mismatch" ? "amount_mismatch" : "invalid",
    };
  }
  if (error instanceof z.ZodError) {
    return { status: "error", reason: "invalid" };
  }
  return { status: "error", reason: "unknown" };
}

function refresh(bookingRequestId: string) {
  revalidatePath("/bookings");
  revalidatePath(`/bookings/${bookingRequestId}`);
}

export async function approveBookingAction(
  _previous: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  try {
    const actor = await requireBookingActor();
    const input = decisionSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
      expectedFrom: formData.get("expectedFrom") ?? undefined,
    });

    await approveBooking({ ...input, actorUserId: actor.userId });
    refresh(input.bookingRequestId);
    return { status: "done" };
  } catch (error) {
    logger.warn(
      { event: "booking_approve_failed", reason: toErrorState(error).status },
      "booking approval refused",
    );
    return toErrorState(error);
  }
}

export async function rejectBookingAction(
  _previous: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  try {
    const actor = await requireBookingActor();
    const input = decisionSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
      reason: formData.get("reason") ?? undefined,
      expectedFrom: formData.get("expectedFrom") ?? undefined,
    });

    await rejectBooking({ ...input, actorUserId: actor.userId });
    refresh(input.bookingRequestId);
    return { status: "done" };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function cancelBookingAction(
  _previous: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  try {
    const actor = await requireBookingActor();
    const input = decisionSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
      reason: formData.get("reason") ?? undefined,
    });

    await cancelBooking({ ...input, actorUserId: actor.userId });
    refresh(input.bookingRequestId);
    return { status: "done" };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function recordPaymentAction(
  _previous: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  try {
    const actor = await requireBookingActor();
    const input = paymentSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
      amount: formData.get("amount"),
      receivedAt: formData.get("receivedAt"),
      reference: formData.get("reference") ?? undefined,
    });

    await recordPayment({
      bookingRequestId: input.bookingRequestId,
      actorUserId: actor.userId,
      amountCents: Math.round(input.amount * 100),
      receivedAt: input.receivedAt,
      reference: input.reference ?? null,
    });

    refresh(input.bookingRequestId);
    return { status: "done" };
  } catch (error) {
    return toErrorState(error);
  }
}
