// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface CapturedRequest {
  target: string;
  logicalUrl: string;
  method: string;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a provider fixture port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("provider HTTP fixture", () => {
  let fixture: ChildProcess;
  let fixtureUrl: string;
  let fixtureErrors = "";

  beforeAll(async () => {
    const port = await freePort();
    fixtureUrl = `http://127.0.0.1:${port}`;
    fixture = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        path.resolve("tests/e2e/helpers/provider-http-fixture.ts"),
      ],
      {
        env: { ...process.env, E2E_PROVIDER_HTTP_PORT: String(port) },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    fixture.stderr?.on("data", (chunk: Buffer) => {
      fixtureErrors += chunk.toString("utf8");
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fixture.exitCode !== null) {
        throw new Error(`Provider fixture exited early: ${fixtureErrors}`);
      }
      try {
        const response = await fetch(`${fixtureUrl}/control/health`);
        if (response.ok) return;
      } catch {
        // The child process has not started listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Provider fixture did not become ready: ${fixtureErrors}`);
  }, 10_000);

  beforeEach(async () => {
    const response = await fetch(`${fixtureUrl}/control/reset`, { method: "POST" });
    expect(response.ok).toBe(true);
  });

  afterAll(async () => {
    if (!fixture || fixture.exitCode !== null) return;
    fixture.kill("SIGTERM");
    await once(fixture, "exit");
  });

  it("serves a URL-scoped synthetic Holded page and captures its logical URL", async () => {
    const configured = await fetch(`${fixtureUrl}/control/holded/page`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "holded.movements",
        urlIncludes: "cursor=page%202",
        items: [{ id: "movement-fixture" }],
        hasMore: true,
        cursor: "page 3",
        once: true,
      }),
    });
    expect(configured.status).toBe(200);

    const providerPath =
      "/provider/holded/api/v2/treasury/accounts/aaaaaaaaaaaaaaaaaaaaaaaa/bank-movements?start_date=2026-09-01&limit=100&cursor=page%202";
    const response = await fetch(`${fixtureUrl}${providerPath}`, {
      headers: { authorization: "Bearer synthetic-key" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [{ id: "movement-fixture" }],
      has_more: true,
      cursor: "page 3",
    });

    const capture = (await (
      await fetch(`${fixtureUrl}/control/requests`)
    ).json()) as { requests: CapturedRequest[] };
    expect(capture.requests).toEqual([
      expect.objectContaining({
        target: "holded.movements",
        method: "GET",
        logicalUrl:
          "https://api.holded.com/api/v2/treasury/accounts/aaaaaaaaaaaaaaaaaaaaaaaa/bank-movements?start_date=2026-09-01&limit=100&cursor=page%202",
      }),
    ]);
  });

  it("serves URL-scoped Holded errors through the shared behavior control", async () => {
    const configured = await fetch(`${fixtureUrl}/control/behavior`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "holded.accounts",
        urlIncludes: "limit=100",
        once: true,
        behavior: {
          status: 503,
          body: '{"message":"synthetic outage"}',
        },
      }),
    });
    expect(configured.status).toBe(200);

    const response = await fetch(
      `${fixtureUrl}/provider/holded/api/v2/treasury/accounts?limit=100`,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      message: "synthetic outage",
    });
  });
});