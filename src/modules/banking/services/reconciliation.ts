import "server-only";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  BOOKING_PAYMENT_TOLERANCE_PERCENT,
  expectedPaymentMinor,
  isAutomaticReconciliationMatch,
  isBookingPaymentCandidate,
  isPaymentAmountWithinTolerance,
} from "@/modules/banking/services/payment-matching";
import {
  PaymentError,
  queueBookingConfirmation,
  recordTrustedPayment,
} from "@/modules/booking/services/decisions";
import type { BookingTransactionClient } from "@/modules/booking/services/lifecycle";
import { BookingTransitionError } from "@/modules/booking/services/lifecycle";
import { enqueueReserveInvoice } from "@/modules/booking/services/reserve-invoice";

export class ReconciliationError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "state_changed"
      | "proposal_changed"
      | "movement_ineligible"
      | "amount_mismatch"
      | "movement_already_used",
  ) {
    super(code);
    this.name = "ReconciliationError";
  }
}

export interface ReconciliationScanResult {
  createdCount: number;
  invalidatedCount: number;
  incidentCount: number;
}

export async function reconcileBankMovements(
  movementIds: string[],
  transaction?: BookingTransactionClient,
  incidentContext?: { runId: string; pageNumber: number },
): Promise<ReconciliationScanResult> {
  const uniqueMovementIds = [...new Set(movementIds)];
  if (uniqueMovementIds.length === 0) {
    return { createdCount: 0, invalidatedCount: 0, incidentCount: 0 };
  }

  const apply = async (
    tx: BookingTransactionClient,
  ): Promise<ReconciliationScanResult> => {
    const [movements, candidateBookings] = await Promise.all([
      tx.bankMovement.findMany({
        where: { id: { in: uniqueMovementIds } },
        select: {
          id: true,
          holdedMovementId: true,
          direction: true,
          amountMinor: true,
          currency: true,
          narrative: true,
          bookingDate: true,
          payment: { select: { id: true } },
          proposals: {
            select: {
              id: true,
              status: true,
              bookingRequestId: true,
              bookingRequest: {
                select: {
                  id: true,
                  state: true,
                  decidedAt: true,
                  advanceCents: true,
                  depositCents: true,
                  documents: {
                    where: { type: "ESTIMATE" },
                    take: 1,
                    select: { documentNumber: true, issuedAt: true },
                  },
                },
              },
            },
          },
        },
      }),
      tx.bookingRequest.findMany({
        where: { state: "AWAITING_PAYMENT" },
        select: {
          id: true,
          state: true,
          decidedAt: true,
          advanceCents: true,
          depositCents: true,
          documents: {
            where: { type: "ESTIMATE" },
            take: 1,
            select: { documentNumber: true, issuedAt: true },
          },
        },
      }),
    ]);

    const proposalsToCreate: Array<{
      movementId: string;
      bookingRequestId: string;
    }> = [];
    const proposalsToInvalidate: string[] = [];
    const correctionIncidents: Array<{
      runId: string;
      code: "CONFIRMED_MATCH_CHANGED";
      pageNumber: number;
      itemIndex: null;
      holdedMovementId: string;
    }> = [];

    for (const movement of movements) {
      const existingByBooking = new Map(
        movement.proposals.map((proposal) => [proposal.bookingRequestId, proposal]),
      );

      for (const proposal of movement.proposals) {
        const automaticMatch = isAutomaticReconciliationMatch(
          movement,
          proposal.bookingRequest,
        );
        const confirmedMatch = isBookingPaymentCandidate(
          movement,
          proposal.bookingRequest,
        );
        if (
          proposal.status === "PENDING" &&
          (movement.payment !== null ||
            proposal.bookingRequest.state !== "AWAITING_PAYMENT" ||
            !automaticMatch)
        ) {
          proposalsToInvalidate.push(proposal.id);
        }
        if (
          proposal.status === "CONFIRMED" &&
          !confirmedMatch &&
          incidentContext
        ) {
          correctionIncidents.push({
            runId: incidentContext.runId,
            code: "CONFIRMED_MATCH_CHANGED",
            pageNumber: incidentContext.pageNumber,
            itemIndex: null,
            holdedMovementId: movement.holdedMovementId,
          });
        }
      }

      if (movement.payment) continue;
      for (const booking of candidateBookings) {
        if (
          !existingByBooking.has(booking.id) &&
          isAutomaticReconciliationMatch(movement, booking)
        ) {
          proposalsToCreate.push({
            movementId: movement.id,
            bookingRequestId: booking.id,
          });
        }
      }
    }

    const [created, invalidated] = await Promise.all([
      proposalsToCreate.length > 0
        ? tx.bankReconciliationProposal.createMany({
            data: proposalsToCreate,
            skipDuplicates: true,
          })
        : Promise.resolve({ count: 0 }),
      proposalsToInvalidate.length > 0
        ? tx.bankReconciliationProposal.updateMany({
            where: { id: { in: proposalsToInvalidate }, status: "PENDING" },
            data: {
              status: "INVALIDATED",
              invalidatedAt: new Date(),
              invalidationCode: "MOVEMENT_INELIGIBLE",
            },
          })
        : Promise.resolve({ count: 0 }),
    ]);
    if (correctionIncidents.length > 0) {
      await tx.bankSyncIncident.createMany({ data: correctionIncidents });
    }

    return {
      createdCount: created.count,
      invalidatedCount: invalidated.count,
      incidentCount: correctionIncidents.length,
    };
  };

  return transaction ? apply(transaction) : db.$transaction(apply);
}

export async function confirmReconciliationProposal(command: {
  proposalId: string;
  actorUserId: string;
  now?: Date;
}): Promise<{ bookingRequestId: string }> {
  const decidedAt = command.now ?? new Date();
  let result: { bookingRequestId: string };

  try {
    result = await db.$transaction(async (transaction) => {
      const proposal = await transaction.bankReconciliationProposal.findUnique({
        where: { id: command.proposalId },
        select: {
          id: true,
          status: true,
          movementId: true,
          bookingRequestId: true,
          movement: {
            select: {
              id: true,
              direction: true,
              amountMinor: true,
              currency: true,
              narrative: true,
              bookingDate: true,
              payment: { select: { id: true } },
            },
          },
          bookingRequest: {
            select: {
              id: true,
              state: true,
              decidedAt: true,
              advanceCents: true,
              depositCents: true,
              documents: {
                where: { type: "ESTIMATE" },
                take: 1,
                select: { documentNumber: true, issuedAt: true },
              },
            },
          },
        },
      });
      if (!proposal) throw new ReconciliationError("not_found");
      if (proposal.status !== "PENDING") {
        throw new ReconciliationError("proposal_changed");
      }
      if (proposal.bookingRequest.state !== "AWAITING_PAYMENT") {
        throw new ReconciliationError("state_changed");
      }
      if (!isAutomaticReconciliationMatch(proposal.movement, proposal.bookingRequest)) {
        if (
          proposal.movement.amountMinor !== expectedPaymentMinor(proposal.bookingRequest)
        ) {
          throw new ReconciliationError("amount_mismatch");
        }
        throw new ReconciliationError("movement_ineligible");
      }
      if (proposal.movement.payment) {
        throw new ReconciliationError("movement_already_used");
      }
      if (proposal.movement.amountMinor > BigInt(2_147_483_647)) {
        throw new ReconciliationError("amount_mismatch");
      }

      const claimed = await transaction.bankReconciliationProposal.updateMany({
        where: { id: proposal.id, status: "PENDING" },
        data: {
          status: "CONFIRMED",
          decidedById: command.actorUserId,
          decidedAt,
        },
      });
      if (claimed.count !== 1) {
        throw new ReconciliationError("proposal_changed");
      }

      const payment = await recordTrustedPayment(
        {
          bookingRequestId: proposal.bookingRequestId,
          actorUserId: command.actorUserId,
          amountCents: Number(proposal.movement.amountMinor),
          receivedAt: proposal.movement.bookingDate,
          reference: proposal.movement.narrative,
          bankMovementId: proposal.movementId,
        },
        transaction,
      );
      await enqueueReserveInvoice(
        {
          bookingRequestId: proposal.bookingRequestId,
          paymentId: payment.id,
        },
        transaction,
      );

      await transaction.bankReconciliationProposal.updateMany({
        where: {
          id: { not: proposal.id },
          status: "PENDING",
          OR: [
            { movementId: proposal.movementId },
            { bookingRequestId: proposal.bookingRequestId },
          ],
        },
        data: {
          status: "INVALIDATED",
          invalidatedAt: decidedAt,
          invalidationCode: "SIBLING_CONFIRMED",
        },
      });

      return { bookingRequestId: proposal.bookingRequestId };
    });
  } catch (error) {
    if (error instanceof ReconciliationError) throw error;
    if (error instanceof BookingTransitionError) {
      throw new ReconciliationError("state_changed");
    }
    if (error instanceof PaymentError) {
      throw new ReconciliationError(
        error.code === "amount_mismatch" ? "amount_mismatch" : "state_changed",
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      throw new ReconciliationError("movement_already_used");
    }
    throw error;
  }

  await queueBookingConfirmation(result.bookingRequestId);
  logger.info(
    {
      event: "bank_reconciliation_confirmed",
      proposalId: command.proposalId,
      bookingRequestId: result.bookingRequestId,
    },
    "bank reconciliation proposal confirmed",
  );
  return result;
}

export async function confirmBookingPaymentCandidate(command: {
  bookingRequestId: string;
  movementId: string;
  actorUserId: string;
  now?: Date;
}): Promise<{ bookingRequestId: string }> {
  const decidedAt = command.now ?? new Date();

  try {
    const result = await db.$transaction(async (transaction) => {
      const [booking, movement] = await Promise.all([
        transaction.bookingRequest.findUnique({
          where: { id: command.bookingRequestId },
          select: {
            id: true,
            state: true,
            decidedAt: true,
            advanceCents: true,
            depositCents: true,
            documents: {
              where: { type: "ESTIMATE" },
              take: 1,
              select: { documentNumber: true, issuedAt: true },
            },
          },
        }),
        transaction.bankMovement.findUnique({
          where: { id: command.movementId },
          select: {
            id: true,
            direction: true,
            amountMinor: true,
            currency: true,
            narrative: true,
            bookingDate: true,
            payment: { select: { id: true } },
          },
        }),
      ]);
      if (!booking || !movement) throw new ReconciliationError("not_found");
      if (booking.state !== "AWAITING_PAYMENT") {
        throw new ReconciliationError("state_changed");
      }
      if (movement.payment) {
        throw new ReconciliationError("movement_already_used");
      }
      if (!isBookingPaymentCandidate(movement, booking)) {
        if (
          !isPaymentAmountWithinTolerance(
            movement.amountMinor,
            expectedPaymentMinor(booking),
          )
        ) {
          throw new ReconciliationError("amount_mismatch");
        }
        throw new ReconciliationError("movement_ineligible");
      }
      if (movement.amountMinor > BigInt(2_147_483_647)) {
        throw new ReconciliationError("amount_mismatch");
      }

      const proposal = await transaction.bankReconciliationProposal.upsert({
        where: {
          movementId_bookingRequestId: {
            movementId: movement.id,
            bookingRequestId: booking.id,
          },
        },
        update: {},
        create: {
          movementId: movement.id,
          bookingRequestId: booking.id,
        },
        select: { id: true, status: true },
      });
      if (proposal.status !== "PENDING") {
        throw new ReconciliationError("proposal_changed");
      }

      const claimed = await transaction.bankReconciliationProposal.updateMany({
        where: { id: proposal.id, status: "PENDING" },
        data: {
          status: "CONFIRMED",
          decidedById: command.actorUserId,
          decidedAt,
        },
      });
      if (claimed.count !== 1) {
        throw new ReconciliationError("proposal_changed");
      }

      const payment = await recordTrustedPayment(
        {
          bookingRequestId: booking.id,
          actorUserId: command.actorUserId,
          amountCents: Number(movement.amountMinor),
          receivedAt: movement.bookingDate,
          reference: movement.narrative,
          bankMovementId: movement.id,
        },
        transaction,
        { amountTolerancePercent: BOOKING_PAYMENT_TOLERANCE_PERCENT },
      );
      await enqueueReserveInvoice(
        { bookingRequestId: booking.id, paymentId: payment.id },
        transaction,
      );

      await transaction.bankReconciliationProposal.updateMany({
        where: {
          id: { not: proposal.id },
          status: "PENDING",
          OR: [
            { movementId: movement.id },
            { bookingRequestId: booking.id },
          ],
        },
        data: {
          status: "INVALIDATED",
          invalidatedAt: decidedAt,
          invalidationCode: "SIBLING_CONFIRMED",
        },
      });

      return { bookingRequestId: booking.id };
    });

    await queueBookingConfirmation(result.bookingRequestId);
    logger.info(
      {
        event: "bank_booking_candidate_confirmed",
        bookingRequestId: result.bookingRequestId,
      },
      "bank movement linked from booking detail",
    );
    return result;
  } catch (error) {
    if (error instanceof ReconciliationError) throw error;
    if (error instanceof BookingTransitionError) {
      throw new ReconciliationError("state_changed");
    }
    if (error instanceof PaymentError) {
      throw new ReconciliationError(
        error.code === "amount_mismatch" ? "amount_mismatch" : "state_changed",
      );
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      throw new ReconciliationError("movement_already_used");
    }
    throw error;
  }
}

export async function dismissBookingPaymentCandidate(command: {
  bookingRequestId: string;
  movementId: string;
  actorUserId: string;
  now?: Date;
}): Promise<void> {
  const decidedAt = command.now ?? new Date();
  await db.$transaction(async (transaction) => {
    const [booking, movement] = await Promise.all([
      transaction.bookingRequest.findUnique({
        where: { id: command.bookingRequestId },
        select: {
          state: true,
          decidedAt: true,
          advanceCents: true,
          depositCents: true,
          documents: {
            where: { type: "ESTIMATE" },
            take: 1,
            select: { documentNumber: true, issuedAt: true },
          },
        },
      }),
      transaction.bankMovement.findUnique({
        where: { id: command.movementId },
        select: {
          direction: true,
          amountMinor: true,
          currency: true,
          narrative: true,
          bookingDate: true,
          payment: { select: { id: true } },
        },
      }),
    ]);
    if (!booking || !movement) throw new ReconciliationError("not_found");
    if (movement.payment || !isBookingPaymentCandidate(movement, booking)) {
      throw new ReconciliationError("movement_ineligible");
    }

    const proposal = await transaction.bankReconciliationProposal.upsert({
      where: {
        movementId_bookingRequestId: {
          movementId: command.movementId,
          bookingRequestId: command.bookingRequestId,
        },
      },
      update: {},
      create: {
        movementId: command.movementId,
        bookingRequestId: command.bookingRequestId,
      },
      select: { id: true, status: true },
    });
    if (proposal.status !== "PENDING") {
      throw new ReconciliationError("proposal_changed");
    }

    const dismissed = await transaction.bankReconciliationProposal.updateMany({
      where: { id: proposal.id, status: "PENDING" },
      data: {
        status: "DISMISSED",
        decidedById: command.actorUserId,
        decidedAt,
      },
    });
    if (dismissed.count !== 1) {
      throw new ReconciliationError("proposal_changed");
    }
  });
}

export async function dismissReconciliationProposal(command: {
  proposalId: string;
  actorUserId: string;
  now?: Date;
}): Promise<void> {
  const decidedAt = command.now ?? new Date();
  const dismissed = await db.bankReconciliationProposal.updateMany({
    where: { id: command.proposalId, status: "PENDING" },
    data: {
      status: "DISMISSED",
      decidedById: command.actorUserId,
      decidedAt,
    },
  });
  if (dismissed.count === 1) return;

  const exists = await db.bankReconciliationProposal.findUnique({
    where: { id: command.proposalId },
    select: { id: true },
  });
  throw new ReconciliationError(exists ? "proposal_changed" : "not_found");
}