import "server-only";

import type { BrevoMailConfig } from "@/lib/env";
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
  type NormalizedSendResult,
  type ProviderAttemptObserver,
  type ProviderHttpClient,
  type TransactionalEmailProvider,
} from "@/lib/email/types";

export const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeBrevoResponse(
  response: ProviderHttpResponse,
): NormalizedSendResult {
  if (response.status < 200 || response.status >= 300) {
    return createSendResult("brevo", classifyHttpStatus(response.status));
  }
  if (response.bodyTooLarge || response.body === null) {
    return createSendResult("brevo", "unknown");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return createSendResult("brevo", "unknown");
  }
  if (!isRecord(parsed) || "code" in parsed || "message" in parsed) {
    return createSendResult("brevo", "unknown");
  }

  const singularId = normalizeProviderMessageId(parsed.messageId);
  let pluralId: string | null = null;
  if ("messageIds" in parsed) {
    if (!Array.isArray(parsed.messageIds)) {
      return createSendResult("brevo", "accepted", singularId);
    }
    const validIds = parsed.messageIds
      .map(normalizeProviderMessageId)
      .filter((value): value is string => value !== null);
    const distinctIds = [...new Set(validIds)];
    if (distinctIds.length > 1) {
      return createSendResult("brevo", "unknown");
    }
    pluralId = parsed.messageIds.length === 1 ? distinctIds[0] ?? null : null;
  }
  if (singularId && pluralId && singularId !== pluralId) {
    return createSendResult("brevo", "unknown");
  }

  return createSendResult("brevo", "accepted", singularId ?? pluralId);
}

export function createBrevoProvider(
  config: BrevoMailConfig,
  client: ProviderHttpClient = nativeProviderHttpClient,
  observeAttempt?: ProviderAttemptObserver,
): TransactionalEmailProvider {
  return {
    provider: "brevo",
    async send(input) {
      const message = validateTransactionalEmail(input);
      const body = serializeProviderJson({
        sender: {
          email: config.fromEmail,
          name: config.senderName,
        },
        // The sending domain may have no MX records, so replies go to support.
        replyTo: { email: config.brand.supportEmail },
        to: [{ email: message.recipient }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html,
      });
      const outcome = await executeProviderRequest({
        client,
        logicalUrl: BREVO_SEND_URL,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "api-key": config.apiKey,
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
        return createSendResult("brevo", "provider_unavailable");
      }
      return normalizeBrevoResponse(outcome);
    },
  };
}
