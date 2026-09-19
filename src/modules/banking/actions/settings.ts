"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import { HoldedError } from "@/lib/holded/client";
import { logger } from "@/lib/logger";
import {
  BankingAuthorizationError,
  requireBankingActor,
} from "@/modules/banking/authorization";
import { saveTreasuryAccountInputSchema } from "@/modules/banking/schema";
import {
  saveTreasuryAccount,
  TreasuryAccountError,
} from "@/modules/banking/services/accounts";
import type { TreasuryAccountSettingsActionState } from "@/modules/banking/types";
import { IntegrationSettingsError } from "@/modules/booking/services/settings";

export type { TreasuryAccountSettingsActionState } from "@/modules/banking/types";

export async function saveTreasuryAccountAction(
  _previous: TreasuryAccountSettingsActionState,
  formData: FormData,
): Promise<TreasuryAccountSettingsActionState> {
  void _previous;
  try {
    const actor = await requireBankingActor("ADMINISTRATOR");
    const parsed = saveTreasuryAccountInputSchema.safeParse({
      holdedAccountId: formData.get("holdedAccountId"),
      importStartDate: formData.get("importStartDate"),
    });
    if (!parsed.success) return { status: "error", reason: "invalid" };

    const saved = await saveTreasuryAccount({
      ...parsed.data,
      configuredById: actor.userId,
    });
    logger.info(
      {
        event: "bank_treasury_account_saved",
        actorId: actor.userId,
        accountId: saved.accountId,
        runId: saved.runId,
      },
      "treasury account configuration saved",
    );
    revalidatePath("/bookings/settings");
    revalidatePath("/bank-movements");
    return { status: "saved" };
  } catch (error) {
    let reason: Extract<
      TreasuryAccountSettingsActionState,
      { status: "error" }
    >["reason"] = "unknown";
    if (error instanceof BankingAuthorizationError) reason = error.code;
    else if (error instanceof TreasuryAccountError) reason = error.code;
    else if (
      error instanceof IntegrationSettingsError &&
      error.code === "not_configured"
    ) {
      reason = "not_configured";
    } else if (error instanceof HoldedError) {
      reason = "connection";
    }

    logger.warn(
      { event: "bank_treasury_account_save_failed", reason },
      "treasury account configuration failed",
    );
    return { status: "error", reason };
  }
}