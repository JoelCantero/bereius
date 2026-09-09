"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { GravityFormsError } from "@/lib/gravity-forms/client";
import { HoldedError } from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import {
  AuthorizationError,
  requireBookingActor,
} from "@/modules/booking/authorization";
import {
  ContactSyncError,
  createCustomerContact,
  linkExistingEstimate,
  updateCustomerContact,
} from "@/modules/booking/services/contact-sync";
import { IntegrationSettingsError } from "@/modules/booking/services/settings";

export type ContactActionState =
  | { status: "idle" }
  | { status: "done" }
  | {
      status: "error";
      reason:
        | "unauthenticated"
        | "forbidden"
        | "invalid"
        | "authentication"
        | "connection"
        | "not_found"
        | "rejected"
        | "unknown";
    };

const bookingSchema = z.object({ bookingRequestId: z.string().min(1) });
const linkSchema = bookingSchema.extend({
  // A 24-character ObjectId, so a stray value never reaches Holded.
  holdedId: z.string().trim().regex(/^[0-9a-f]{24}$/u),
});

function toErrorState(error: unknown): ContactActionState {
  if (error instanceof AuthorizationError) {
    return { status: "error", reason: error.code };
  }
  if (error instanceof ContactSyncError || error instanceof z.ZodError) {
    return { status: "error", reason: "invalid" };
  }
  if (error instanceof IntegrationSettingsError) {
    return { status: "error", reason: "invalid" };
  }
  if (error instanceof HoldedError || error instanceof GravityFormsError) {
    if (error.code === "unauthorized") return { status: "error", reason: "authentication" };
    if (error.code === "not_found") return { status: "error", reason: "not_found" };
    return {
      status: "error",
      reason:
        error.code === "unavailable" || error.code === "rate_limited"
          ? "connection"
          : "rejected",
    };
  }
  return { status: "error", reason: "unknown" };
}

function refresh(bookingRequestId: string) {
  revalidatePath(`/bookings/${bookingRequestId}`);
}

async function run(
  event: string,
  bookingRequestId: string,
  work: () => Promise<void>,
): Promise<ContactActionState> {
  try {
    await work();
    refresh(bookingRequestId);
    return { status: "done" };
  } catch (error) {
    const state = toErrorState(error);
    logger.warn(
      {
        event,
        bookingRequestId,
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "holded contact action failed",
    );
    return state;
  }
}

export async function createContactAction(
  _previous: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  try {
    await requireBookingActor();
    const { bookingRequestId } = bookingSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
    });

    return await run("booking_contact_create_failed", bookingRequestId, () =>
      createCustomerContact(bookingRequestId),
    );
  } catch (error) {
    return toErrorState(error);
  }
}

export async function updateContactAction(
  _previous: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  try {
    await requireBookingActor();
    const { bookingRequestId } = bookingSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
    });

    return await run("booking_contact_update_failed", bookingRequestId, () =>
      updateCustomerContact(bookingRequestId),
    );
  } catch (error) {
    return toErrorState(error);
  }
}

export async function linkEstimateAction(
  _previous: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  try {
    const actor = await requireBookingActor();
    const { bookingRequestId, holdedId } = linkSchema.parse({
      bookingRequestId: formData.get("bookingRequestId"),
      holdedId: formData.get("holdedId"),
    });

    return await run("booking_estimate_link_failed", bookingRequestId, async () => {
      await linkExistingEstimate(bookingRequestId, holdedId, actor.userId);
      // The same link is shown from the contract side, which must not go stale.
      revalidatePath("/contracts");
      revalidatePath(`/contracts/${holdedId}`);
    });
  } catch (error) {
    return toErrorState(error);
  }
}
