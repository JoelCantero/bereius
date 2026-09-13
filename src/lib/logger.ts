import "server-only";

import pino, { type DestinationStream, type Logger } from "pino";

import { getEnv } from "@/lib/env";
import { getRequestId } from "@/lib/request-context";

// Application logger (constitution Principle VIII + Observability Rules).
//
// Emits newline-delimited JSON to stdout in every environment. The app never
// writes log files: the host's Docker log driver / collector ships stdout to an
// aggregator (e.g. Loki/Grafana), keeping the app infrastructure-agnostic and
// the runtime footprint minimal on constrained hardware.
//
// For readable local logs, pipe through pino-pretty: `pnpm dev | pnpm exec pino-pretty`.
//
// NOTE: this module is server-only and relies on Node APIs — do NOT import it
// from the edge runtime (e.g. `src/proxy.ts`); use `console` there instead.
export function createLogger(
  envSource: NodeJS.ProcessEnv = process.env,
  destination?: DestinationStream,
): Logger {
  const env = getEnv(envSource);
  const level =
    env.LOG_LEVEL ?? (envSource.NODE_ENV === "production" ? "info" : "debug");

  return pino(
    {
      level,
      base: { app: env.PROJECT_NAME, env: envSource.NODE_ENV },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Emit the level name ("info") instead of Pino's numeric level (30).
      formatters: {
        level: (label) => ({ level: label }),
      },
      // Never leak secrets or PII into logs (constitution Principle X).
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "email",
          "*.email",
          "name",
          "firstName",
          "lastName",
          "*.firstName",
          "*.name",
          "*.lastName",
          "*.proposedName",
          "*.identifier",
          "phone",
          "*.phone",
          "taxId",
          "*.taxId",
          "vatNumber",
          "*.vatNumber",
          "fiscalEmail",
          "*.fiscalEmail",
          "toEmail",
          "*.toEmail",
          "ccEmails",
          "*.ccEmails",
          "emails",
          "*.emails",
          "cc",
          "*.cc",
          "*.url",
          "*.image",
          "*.password",
          "*.token",
          "*.sessionToken",
          "secret",
          "*.secret",
          "signature",
          "*.signature",
          "signatureHeader",
          "*.signatureHeader",
          "hmac",
          "*.hmac",
          "apiKey",
          "*.apiKey",
          "apiSecret",
          "*.apiSecret",
          "authorization",
          "*.authorization",
          "recipient",
          "*.recipient",
          "fromEmail",
          "*.fromEmail",
          "subject",
          "*.subject",
          "text",
          "*.text",
          "html",
          "*.html",
          "body",
          "*.body",
          "rawBody",
          "*.rawBody",
          "raw",
          "*.raw",
          "headers",
          "*.headers",
          "DATABASE_URL",
          "AUTH_SECRET",
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}

export const logger = createLogger();

export function getRequestLogger(
  request: Request,
  bindings: Record<string, unknown> = {},
): Logger {
  return logger.child({
    ...bindings,
    requestId: getRequestId(request),
  });
}
