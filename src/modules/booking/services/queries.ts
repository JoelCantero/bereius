import "server-only";

import type { BookingState } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

export const BOOKING_QUEUE_PAGE_SIZE = 25;

export interface BookingQueueFilters {
  state?: BookingState;
  /** Matches customer name, tax identifier or email. */
  search?: string;
  from?: Date;
  to?: Date;
}

export interface BookingQueueItem {
  id: string;
  state: BookingState;
  customerName: string;
  taxId: string;
  startDate: Date;
  endDate: Date;
  headcount: number;
  boardType: string;
  submittedAt: Date;
  paymentDueAt: Date | null;
}

export async function listBookingQueue(
  filters: BookingQueueFilters = {},
): Promise<BookingQueueItem[]> {
  const search = filters.search?.trim();

  const rows = await db.bookingRequest.findMany({
    where: {
      ...(filters.state ? { state: filters.state } : {}),
      ...(filters.from || filters.to
        ? {
            startDate: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            customer: {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { taxId: { contains: search.toUpperCase() } },
                { email: { contains: search.toLowerCase() } },
              ],
            },
          }
        : {}),
    },
    orderBy: [{ state: "asc" }, { createdAt: "desc" }],
    take: BOOKING_QUEUE_PAGE_SIZE,
    select: {
      id: true,
      state: true,
      startDate: true,
      endDate: true,
      headcount: true,
      boardType: true,
      submittedAt: true,
      paymentDueAt: true,
      customer: { select: { name: true, taxId: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    customerName: row.customer.name,
    taxId: row.customer.taxId,
    startDate: row.startDate,
    endDate: row.endDate,
    headcount: row.headcount,
    boardType: row.boardType,
    submittedAt: row.submittedAt,
    paymentDueAt: row.paymentDueAt,
  }));
}

export async function getBookingDetail(bookingRequestId: string) {
  return db.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    include: {
      customer: true,
      documents: { orderBy: { issuedAt: "asc" } },
      payments: { orderBy: { receivedAt: "asc" } },
      auditEvents: {
        orderBy: { createdAt: "asc" },
        include: { actor: { select: { name: true, email: true } } },
      },
    },
  });
}
