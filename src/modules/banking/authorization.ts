import "server-only";

import { getServerSession } from "next-auth";

import type { UserRole } from "@/generated/prisma/enums";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/modules/account/session";

export interface BankingActor {
  userId: string;
  role: UserRole;
}

export class BankingAuthorizationError extends Error {
  constructor(readonly code: "unauthenticated" | "forbidden") {
    super(code);
    this.name = "BankingAuthorizationError";
  }
}

export async function requireBankingActor(
  minimumRole: UserRole = "OPERATOR",
): Promise<BankingActor> {
  const session = await getServerSession(authOptions);
  const userId = getSessionUserId(session);

  if (!userId) {
    throw new BankingAuthorizationError("unauthenticated");
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });

  if (!user || user.status !== "ACTIVE") {
    throw new BankingAuthorizationError("unauthenticated");
  }
  if (minimumRole === "ADMINISTRATOR" && user.role !== "ADMINISTRATOR") {
    throw new BankingAuthorizationError("forbidden");
  }

  return { userId: user.id, role: user.role };
}