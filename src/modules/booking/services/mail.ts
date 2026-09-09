import "server-only";

import { z } from "zod";

import { createSmtpSender, type SmtpSender } from "@/lib/mail/smtp";
import { getEnv } from "@/lib/env";
import { enqueueJob, type OutboxJob } from "@/modules/booking/services/outbox";
import { resolveIntegration } from "@/modules/booking/services/settings";

export const BOOKING_MAIL_JOB_KIND = "booking.mail";

const messagePayloadSchema = z.object({
  to: z.email(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().min(1).optional(),
  replyTo: z.email().optional(),
});

export type BookingMailPayload = z.infer<typeof messagePayloadSchema>;

/**
 * Queues a booking notification.
 *
 * SMTP holds a connection and is slower than an HTTPS call, so delivery never
 * runs inside the request that triggers it. The key makes a repeated enqueue
 * for the same reason a no-op.
 */
export async function queueBookingMail(
  idempotencyKey: string,
  payload: BookingMailPayload,
): Promise<boolean> {
  return enqueueJob({
    kind: BOOKING_MAIL_JOB_KIND,
    idempotencyKey: `${BOOKING_MAIL_JOB_KIND}:${idempotencyKey}`,
    payload: messagePayloadSchema.parse(payload),
  });
}

export async function resolveBookingMailSender(): Promise<SmtpSender> {
  const { config, secret } = await resolveIntegration("BOOKING_MAIL");

  return createSmtpSender(
    {
      host: config.host,
      port: config.port,
      secure: config.secure,
      username: config.username,
      password: secret,
      fromEmail: config.fromEmail,
    },
    getEnv().PROJECT_NAME.trim(),
  );
}

export async function runBookingMailJob(
  job: OutboxJob,
  overrides: { sender?: SmtpSender } = {},
): Promise<void> {
  const message = messagePayloadSchema.parse(job.payload);
  const sender = overrides.sender ?? (await resolveBookingMailSender());

  await sender.send(message);
}
