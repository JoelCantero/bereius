import "server-only";

import { getServerSession } from "next-auth";

import type { UserRole } from "@/generated/prisma/enums";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/modules/account/session";

export interface BookingActor {
  userId: string;
  role: UserRole;
}

export class AuthorizationError extends Error {
  constructor(readonly code: "unauthenticated" | "forbidden") {
    super(code);
    this.name = "AuthorizationError";
  }
}

/**
 * Resolves the actor from the session and reads the role from the database.
 *
 * The role is never taken from the session payload: a token minted before a
 * demotion would otherwise keep its old privileges until it expired.
 */
export async function requireBookingActor(
  minimumRole: UserRole = "OPERATOR",
): Promise<BookingActor> {
  const session = await getServerSession(authOptions);
  const userId = getSessionUserId(session);

  if (!userId) {
    throw new AuthorizationError("unauthenticated");
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });

  if (!user || user.status !== "ACTIVE") {
    throw new AuthorizationError("unauthenticated");
  }
  if (minimumRole === "ADMINISTRATOR" && user.role !== "ADMINISTRATOR") {
    throw new AuthorizationError("forbidden");
  }

  return { userId: user.id, role: user.role };
}
