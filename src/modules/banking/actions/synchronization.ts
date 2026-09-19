"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import { logger } from "@/lib/logger";
import {
  BankingAuthorizationError,
  requireBankingActor,
} from "@/modules/banking/authorization";
import { requestBankSyncInputSchema } from "@/modules/banking/schema";
import {
  BankSyncRequestError,
  requestManualBankSync,
} from "@/modules/banking/services/synchronization";
import type { BankSyncActionState } from "@/modules/banking/types";

export type { BankSyncActionState } from "@/modules/banking/types";

export async function requestBankSyncAction(
  _previous: BankSyncActionState,
  formData: FormData,
): Promise<BankSyncActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor();
    const parsed = requestBankSyncInputSchema.safeParse({
      retryRunId: formData.get("retryRunId") || undefined,
    });
    if (!parsed.success) return { status: "error", reason: "invalid" };

    const requested = await requestManualBankSync({
      requestedById: actor.userId,
      retryRunId: parsed.data.retryRunId,
    });
    logger.info(
      {
        event: "bank_sync_requested",
        actorId: actor.userId,
        accountId: requested.accountId,
        runId: requested.runId,
        created: requested.created,
      },
      "bank synchronization requested",
    );
    revalidatePath("/bank-movements");
    revalidatePath("/bookings/settings");
    return {
      status: requested.created ? "accepted" : "already_running",
      runId: requested.runId,
    };
  } catch (error) {
    let reason: Extract<BankSyncActionState, { status: "error" }>["reason"] =
      "unknown";
    if (error instanceof BankingAuthorizationError) reason = error.code;
    else if (error instanceof BankSyncRequestError) reason = error.code;

    logger.warn(
      { event: "bank_sync_request_failed", reason },
      "bank synchronization request refused",
    );
    return { status: "error", reason };
  }
}