import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.env.E2E_PROVIDER_HTTP_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("E2E_PROVIDER_HTTP_PORT must be a valid port");
}

type ProviderTarget =
  | "brevo.health"
  | "brevo.send"
  | "mailjet.health"
  | "mailjet.send"
  | "holded.accounts"
  | "holded.movements";

interface ProviderBehavior {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
  disconnect?: boolean;
}

interface ProviderBehaviorRule {
  target: ProviderTarget;
  behavior: ProviderBehavior;
  bodyIncludes?: string;
  urlIncludes?: string;
  once?: boolean;
}

interface CapturedRequest {
  target: ProviderTarget;
  logicalUrl: string;
  method: string;
  headers: Record<string, string | string[]>;
  body: string;
}

const targetByPath = new Map<string, ProviderTarget>([
  ["/provider/brevo/health", "brevo.health"],
  ["/provider/brevo/send", "brevo.send"],
  ["/provider/mailjet/health", "mailjet.health"],
  ["/provider/mailjet/send", "mailjet.send"],
]);
const logicalUrlByTarget: Record<ProviderTarget, string> = {
  "brevo.health": "https://api.brevo.com/v3/account",
  "brevo.send": "https://api.brevo.com/v3/smtp/email",
  "mailjet.health": "https://api.mailjet.com/v3/REST/sender?Limit=1",
  "mailjet.send": "https://api.mailjet.com/v3.1/send",
  "holded.accounts": "https://api.holded.com/api/v2/treasury/accounts",
  "holded.movements": "https://api.holded.com/api/v2/treasury/accounts",
};
const providerTargets = new Set<ProviderTarget>([
  "brevo.health",
  "brevo.send",
  "mailjet.health",
  "mailjet.send",
  "holded.accounts",
  "holded.movements",
]);
const requests: CapturedRequest[] = [];
const behaviors: ProviderBehaviorRule[] = [];

function isProviderTarget(value: unknown): value is ProviderTarget {
  return typeof value === "string" && providerTargets.has(value as ProviderTarget);
}

function resolveProviderRequest(url: URL): {
  target: ProviderTarget;
  logicalUrl: string;
} | null {
  const fixedTarget = targetByPath.get(url.pathname);
  if (fixedTarget) {
    return { target: fixedTarget, logicalUrl: logicalUrlByTarget[fixedTarget] };
  }

  const prefix = "/provider/holded";
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  const logicalPath = url.pathname.slice(prefix.length);
  const accountsPath = "/api/v2/treasury/accounts";
  const movementsPath = new RegExp(
    `^${accountsPath}/[0-9a-f]{24}/bank-movements$`,
    "iu",
  );
  const target =
    logicalPath === accountsPath
      ? "holded.accounts"
      : movementsPath.test(logicalPath)
        ? "holded.movements"
        : null;
  if (!target) return null;
  return {
    target,
    logicalUrl: `https://api.holded.com${logicalPath}${url.search}`,
  };
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_048_576) throw new Error("fixture request body too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function defaultResponse(target: ProviderTarget, body: string): ProviderBehavior {
  if (target.startsWith("holded.")) {
    return {
      status: 200,
      body: JSON.stringify({ items: [], has_more: false, cursor: null }),
    };
  }
  if (target.endsWith(".health")) {
    return { status: 200, body: "{}" };
  }
  if (target === "brevo.send") {
    return {
      status: 201,
      body: JSON.stringify({ messageId: `e2e-brevo-${requests.length}` }),
    };
  }

  let recipient = "unknown@example.test";
  try {
    const parsed = JSON.parse(body) as {
      Messages?: Array<{ To?: Array<{ Email?: string }> }>;
    };
    recipient = parsed.Messages?.[0]?.To?.[0]?.Email ?? recipient;
  } catch {
    // The application adapter decides how malformed requests are handled.
  }
  return {
    status: 200,
    body: JSON.stringify({
      Messages: [
        {
          Status: "success",
          To: [
            {
              Email: recipient,
              MessageUUID: `e2e-mailjet-${requests.length}`,
            },
          ],
        },
      ],
    }),
  };
}

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
) {
  if (request.method === "GET" && pathname === "/control/health") {
    json(response, 200, { status: "ok" });
    return true;
  }
  if (request.method === "POST" && pathname === "/control/reset") {
    requests.splice(0);
    behaviors.splice(0);
    json(response, 200, { status: "reset" });
    return true;
  }
  if (request.method === "GET" && pathname === "/control/requests") {
    json(response, 200, { requests });
    return true;
  }
  if (request.method === "POST" && pathname === "/control/behavior") {
    const payload = JSON.parse(await readBody(request)) as {
      target?: ProviderTarget;
      behavior?: ProviderBehavior;
      bodyIncludes?: string;
      urlIncludes?: string;
      once?: boolean;
    };
    if (!isProviderTarget(payload.target) || !payload.behavior) {
      json(response, 400, { status: "invalid" });
      return true;
    }
    const { status, delayMs } = payload.behavior;
    if (
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      (delayMs !== undefined && (!Number.isInteger(delayMs) || delayMs < 0))
      || (payload.bodyIncludes !== undefined &&
        (typeof payload.bodyIncludes !== "string" ||
          payload.bodyIncludes.length === 0 ||
          payload.bodyIncludes.length > 320))
      || (payload.urlIncludes !== undefined &&
        (typeof payload.urlIncludes !== "string" ||
          payload.urlIncludes.length === 0 ||
          payload.urlIncludes.length > 320))
      || (payload.once !== undefined && typeof payload.once !== "boolean")
    ) {
      json(response, 400, { status: "invalid" });
      return true;
    }
    const existingRule = behaviors.findIndex(
      (rule) =>
        rule.target === payload.target &&
        rule.bodyIncludes === payload.bodyIncludes &&
        rule.urlIncludes === payload.urlIncludes,
    );
    if (existingRule >= 0) behaviors.splice(existingRule, 1);
    behaviors.push({
      target: payload.target,
      behavior: payload.behavior,
      bodyIncludes: payload.bodyIncludes,
      urlIncludes: payload.urlIncludes,
      once: payload.once,
    });
    json(response, 200, { status: "configured", target: payload.target });
    return true;
  }
  if (request.method === "POST" && pathname === "/control/holded/page") {
    const payload = JSON.parse(await readBody(request)) as {
      target?: "holded.accounts" | "holded.movements";
      urlIncludes?: string;
      items?: unknown[];
      hasMore?: boolean;
      cursor?: string | null;
      once?: boolean;
    };
    const hasMore = payload.hasMore ?? false;
    const cursor = payload.cursor ?? null;
    if (
      (payload.target !== "holded.accounts" &&
        payload.target !== "holded.movements") ||
      !Array.isArray(payload.items) ||
      payload.items.length > 100 ||
      typeof hasMore !== "boolean" ||
      (cursor !== null &&
        (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 320)) ||
      (hasMore && cursor === null) ||
      (payload.urlIncludes !== undefined &&
        (typeof payload.urlIncludes !== "string" ||
          payload.urlIncludes.length === 0 ||
          payload.urlIncludes.length > 320)) ||
      (payload.once !== undefined && typeof payload.once !== "boolean")
    ) {
      json(response, 400, { status: "invalid" });
      return true;
    }
    const existingRule = behaviors.findIndex(
      (rule) =>
        rule.target === payload.target &&
        rule.bodyIncludes === undefined &&
        rule.urlIncludes === payload.urlIncludes,
    );
    if (existingRule >= 0) behaviors.splice(existingRule, 1);
    behaviors.push({
      target: payload.target,
      urlIncludes: payload.urlIncludes,
      once: payload.once,
      behavior: {
        status: 200,
        body: JSON.stringify({
          items: payload.items,
          has_more: hasMore,
          cursor,
        }),
      },
    });
    json(response, 200, { status: "configured", target: payload.target });
    return true;
  }
  return false;
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://fixture.test");
    const pathname = requestUrl.pathname;
    if (await handleControl(request, response, pathname)) return;

    const providerRequest = resolveProviderRequest(requestUrl);
    if (!providerRequest) {
      json(response, 404, { status: "not_found" });
      return;
    }
    const body = await readBody(request);
    requests.push({
      target: providerRequest.target,
      logicalUrl: providerRequest.logicalUrl,
      method: request.method ?? "GET",
      headers: request.headers as Record<string, string | string[]>,
      body,
    });
    const ruleIndex = behaviors.findIndex(
      (rule) =>
        rule.target === providerRequest.target &&
        (!rule.bodyIncludes || body.includes(rule.bodyIncludes)) &&
        (!rule.urlIncludes || providerRequest.logicalUrl.includes(rule.urlIncludes)),
    );
    const rule = ruleIndex >= 0 ? behaviors[ruleIndex] : undefined;
    const behavior = rule
      ? rule.behavior
      : defaultResponse(providerRequest.target, body);
    if (rule?.once) behaviors.splice(ruleIndex, 1);
    if (behavior.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
    }
    if (behavior.disconnect) {
      request.socket.destroy();
      return;
    }
    response.statusCode = behavior.status;
    for (const [name, value] of Object.entries(
      behavior.headers ?? { "content-type": "application/json" },
    )) {
      response.setHeader(name, value);
    }
    response.end(behavior.body ?? "");
  } catch {
    if (!response.headersSent) json(response, 400, { status: "invalid" });
    else response.destroy();
  }
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}

console.log(`E2E provider fixture ready on 127.0.0.1:${port}`);
