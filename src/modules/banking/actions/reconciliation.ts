"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import { logger } from "@/lib/logger";
import {
  BankingAuthorizationError,
  requireBankingActor,
} from "@/modules/banking/authorization";
import {
  bookingPaymentCandidateActionInputSchema,
  proposalActionInputSchema,
} from "@/modules/banking/schema";
import {
  confirmBookingPaymentCandidate,
  confirmReconciliationProposal,
  dismissBookingPaymentCandidate,
  dismissReconciliationProposal,
  ReconciliationError,
} from "@/modules/banking/services/reconciliation";
import type { ReconciliationActionState } from "@/modules/banking/types";

export type { ReconciliationActionState } from "@/modules/banking/types";

function errorState(error: unknown): ReconciliationActionState {
  if (error instanceof BankingAuthorizationError) {
    return { status: "error", reason: error.code };
  }
  if (error instanceof ReconciliationError) {
    return { status: "error", reason: error.code };
  }
  return { status: "error", reason: "unknown" };
}

function parseProposalId(formData: FormData) {
  return proposalActionInputSchema.safeParse({
    proposalId: formData.get("proposalId"),
  });
}

function parseBookingCandidate(formData: FormData) {
  return bookingPaymentCandidateActionInputSchema.safeParse({
    bookingRequestId: formData.get("bookingRequestId"),
    movementId: formData.get("movementId"),
  });
}

export async function confirmBookingPaymentCandidateAction(
  _previous: ReconciliationActionState,
  formData: FormData,
): Promise<ReconciliationActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = parseBookingCandidate(formData);
    if (!parsed.success) return { status: "error", reason: "invalid" };

    const result = await confirmBookingPaymentCandidate({
      ...parsed.data,
      actorUserId: actor.userId,
    });
    revalidatePath("/bank-movements");
    revalidatePath("/bookings");
    revalidatePath(`/bookings/${result.bookingRequestId}`);
    return { status: "confirmed", bookingRequestId: result.bookingRequestId };
  } catch (error) {
    const state = errorState(error);
    logger.warn(
      {
        event: "bank_booking_candidate_confirm_action_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "booking payment candidate confirmation refused",
    );
    return state;
  }
}

export async function dismissBookingPaymentCandidateAction(
  _previous: ReconciliationActionState,
  formData: FormData,
): Promise<ReconciliationActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = parseBookingCandidate(formData);
    if (!parsed.success) return { status: "error", reason: "invalid" };

    await dismissBookingPaymentCandidate({
      ...parsed.data,
      actorUserId: actor.userId,
    });
    revalidatePath("/bank-movements");
    revalidatePath(`/bookings/${parsed.data.bookingRequestId}`);
    return { status: "dismissed" };
  } catch (error) {
    const state = errorState(error);
    logger.warn(
      {
        event: "bank_booking_candidate_dismiss_action_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "booking payment candidate dismissal refused",
    );
    return state;
  }
}

export async function confirmReconciliationProposalAction(
  _previous: ReconciliationActionState,
  formData: FormData,
): Promise<ReconciliationActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = parseProposalId(formData);
    if (!parsed.success) return { status: "error", reason: "invalid" };

    const result = await confirmReconciliationProposal({
      proposalId: parsed.data.proposalId,
      actorUserId: actor.userId,
    });
    revalidatePath("/bank-movements");
    revalidatePath("/bookings");
    revalidatePath(`/bookings/${result.bookingRequestId}`);
    return { status: "confirmed", bookingRequestId: result.bookingRequestId };
  } catch (error) {
    const state = errorState(error);
    logger.warn(
      {
        event: "bank_reconciliation_confirm_action_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "bank reconciliation confirmation refused",
    );
    return state;
  }
}

export async function dismissReconciliationProposalAction(
  _previous: ReconciliationActionState,
  formData: FormData,
): Promise<ReconciliationActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = parseProposalId(formData);
    if (!parsed.success) return { status: "error", reason: "invalid" };

    await dismissReconciliationProposal({
      proposalId: parsed.data.proposalId,
      actorUserId: actor.userId,
    });
    revalidatePath("/bank-movements");
    return { status: "dismissed" };
  } catch (error) {
    const state = errorState(error);
    logger.warn(
      {
        event: "bank_reconciliation_dismiss_action_failed",
        reason: state.status === "error" ? state.reason : "unknown",
      },
      "bank reconciliation dismissal refused",
    );
    return state;
  }
}