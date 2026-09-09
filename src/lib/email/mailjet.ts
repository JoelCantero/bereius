import "server-only";

import type { MailjetMailConfig } from "@/lib/env";
import {
  classifyHttpStatus,
  executeProviderRequest,
  nativeProviderHttpClient,
  serializeProviderJson,
  type ProviderHttpResponse,
} from "@/lib/email/http";
import {
  createSendResult,
  normalizeProviderMessageId,
  validateTransactionalEmail,
  type EmailSendCategory,
  type NormalizedSendResult,
  type ProviderAttemptObserver,
  type ProviderHttpClient,
  type TransactionalEmail,
  type TransactionalEmailProvider,
} from "@/lib/email/types";

export const MAILJET_SEND_URL = "https://api.mailjet.com/v3.1/send";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function embeddedErrorCategory(value: unknown): EmailSendCategory {
  if (!Array.isArray(value) || value.length === 0) return "unknown";
  const statusCodes = value.flatMap((error) => {
    if (!isRecord(error)) return [];
    const statusCode = error.StatusCode;
    return typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 100 &&
      statusCode <= 599
      ? [statusCode]
      : [];
  });
  const distinctCodes = [...new Set(statusCodes)];
  return distinctCodes.length === 1
    ? classifyHttpStatus(distinctCodes[0]!)
    : "unknown";
}

function normalizeMailjetIdentifier(recipient: Record<string, unknown>) {
  const uuid = normalizeProviderMessageId(recipient.MessageUUID);
  if (uuid) return uuid;

  const id = recipient.MessageID;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
    return null;
  }
  return normalizeProviderMessageId(String(id));
}

function normalizeMailjetResponse(
  response: ProviderHttpResponse,
  message: TransactionalEmail,
): NormalizedSendResult {
  if (response.status < 200 || response.status >= 300) {
    return createSendResult("mailjet", classifyHttpStatus(response.status));
  }
  if (response.bodyTooLarge || response.body === null) {
    return createSendResult("mailjet", "unknown");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return createSendResult("mailjet", "unknown");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.Messages) || parsed.Messages.length !== 1) {
    return createSendResult("mailjet", "unknown");
  }

  const result = parsed.Messages[0];
  if (!isRecord(result)) return createSendResult("mailjet", "unknown");
  if (result.Status !== "success") {
    return createSendResult(
      "mailjet",
      result.Status === "error" ? embeddedErrorCategory(result.Errors) : "unknown",
    );
  }
  if (
    "Errors" in result &&
    (!Array.isArray(result.Errors) || result.Errors.length > 0)
  ) {
    return createSendResult("mailjet", "unknown");
  }
  if (!Array.isArray(result.To) || result.To.length !== 1) {
    return createSendResult("mailjet", "unknown");
  }
  const recipient = result.To[0];
  if (!isRecord(recipient)) return createSendResult("mailjet", "unknown");
  if (
    typeof recipient.Email !== "string" ||
    recipient.Email.trim().toLowerCase() !== message.recipient.toLowerCase()
  ) {
    return createSendResult("mailjet", "unknown");
  }

  return createSendResult(
    "mailjet",
    "accepted",
    normalizeMailjetIdentifier(recipient),
  );
}

export function createMailjetProvider(
  config: MailjetMailConfig,
  client: ProviderHttpClient = nativeProviderHttpClient,
  observeAttempt?: ProviderAttemptObserver,
): TransactionalEmailProvider {
  return {
    provider: "mailjet",
    async send(input) {
      const message = validateTransactionalEmail(input);
      const body = serializeProviderJson({
        Messages: [
          {
            From: {
              Email: config.fromEmail,
              Name: config.senderName,
            },
            // The sending domain may have no MX records, so replies go to support.
            ReplyTo: { Email: config.brand.supportEmail },
            To: [{ Email: message.recipient }],
            Subject: message.subject,
            TextPart: message.text,
            HTMLPart: message.html,
          },
        ],
      });
      const authorization = Buffer.from(
        `${config.apiKey}:${config.apiSecret}`,
      ).toString("base64");
      const outcome = await executeProviderRequest({
        client,
        logicalUrl: MAILJET_SEND_URL,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Basic ${authorization}`,
          },
          body,
        },
        timeoutMs: config.sendTimeoutMs,
      });
      try {
        observeAttempt?.({
          statusClass: outcome.kind === "response" ? outcome.statusClass : null,
          durationMs: outcome.durationMs,
        });
      } catch {
        // Observability cannot change the submission result.
      }

      if (outcome.kind === "network_error") {
        return createSendResult("mailjet", "provider_unavailable");
      }
      return normalizeMailjetResponse(outcome, message);
    },
  };
}
