import {
  EMAIL_REQUEST_LIMIT_BYTES,
  EMAIL_RESPONSE_LIMIT_BYTES,
  type EmailSendCategory,
  type ProviderHttpClient,
} from "@/lib/email/types";

export interface ProviderHttpResponse {
  kind: "response";
  status: number;
  statusClass: string | null;
  contentType: string | null;
  body: string | null;
  bodyTooLarge: boolean;
  durationMs: number;
}

export interface ProviderHttpFailure {
  kind: "network_error";
  durationMs: number;
}

export type ProviderHttpOutcome = ProviderHttpResponse | ProviderHttpFailure;

function statusClass(status: number) {
  return status >= 100 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : null;
}

export function classifyHttpStatus(status: number): EmailSendCategory {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 409) return "invalid_request";
  if (status >= 500 && status <= 599) return "provider_unavailable";
  return "unknown";
}

export function serializeProviderJson(value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new Error("Invalid email provider request");
  }

  if (new TextEncoder().encode(body).byteLength > EMAIL_REQUEST_LIMIT_BYTES) {
    throw new Error("Email provider request exceeds size limit");
  }
  return body;
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ body: string | null; bodyTooLarge: boolean }> {
  if (!response.body) return { body: "", bodyTooLarge: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return { body: null, bodyTooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(bytes), bodyTooLarge: false };
}

export async function executeProviderRequest({
  client,
  logicalUrl,
  init,
  timeoutMs,
  maxResponseBytes = EMAIL_RESPONSE_LIMIT_BYTES,
}: {
  client: ProviderHttpClient;
  logicalUrl: string;
  init: RequestInit;
  timeoutMs: number;
  /** Raised only by callers that legitimately read a large listing. */
  maxResponseBytes?: number;
}): Promise<ProviderHttpOutcome> {
  const startedAt = performance.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await client(logicalUrl, {
      ...init,
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    const { body, bodyTooLarge } = await readBoundedBody(
      response,
      signal,
      maxResponseBytes,
    );
    return {
      kind: "response",
      status: response.status,
      statusClass: statusClass(response.status),
      contentType: response.headers.get("content-type"),
      body,
      bodyTooLarge,
      durationMs: Math.max(0, performance.now() - startedAt),
    };
  } catch {
    return {
      kind: "network_error",
      durationMs: Math.max(0, performance.now() - startedAt),
    };
  }
}

export const nativeProviderHttpClient: ProviderHttpClient = (logicalUrl, init) =>
  fetch(logicalUrl, init);