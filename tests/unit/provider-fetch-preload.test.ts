// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

describe("provider fetch preload", () => {
  const originalEnv = process.env;
  const nativeFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response('{"status":"fixture"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      E2E_PROVIDER_HTTP_URL: "http://127.0.0.1:47891",
    };
    vi.stubGlobal("fetch", nativeFetch);
    const preloadUrl = new URL(
      "../../tests/e2e/helpers/provider-fetch-preload.mjs",
      import.meta.url,
    );
    preloadUrl.searchParams.set("test", String(Date.now()));
    await import(/* @vite-ignore */ preloadUrl.href);
  });

  afterAll(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("forwards only Holded treasury account URLs with path and query intact", async () => {
    const movementUrl =
      "https://api.holded.com/api/v2/treasury/accounts/aaaaaaaaaaaaaaaaaaaaaaaa/bank-movements?start_date=2026-09-01&limit=100&cursor=page%202";

    await globalThis.fetch(movementUrl, {
      headers: { authorization: "Bearer synthetic-holded-key" },
    });

    expect(nativeFetch).toHaveBeenCalledWith(
      new URL(
        "http://127.0.0.1:47891/provider/holded/api/v2/treasury/accounts/aaaaaaaaaaaaaaaaaaaaaaaa/bank-movements?start_date=2026-09-01&limit=100&cursor=page%202",
      ),
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const forwardedHeaders = nativeFetch.mock.calls.at(-1)?.[1]?.headers;
    expect(new Headers(forwardedHeaders).get("authorization")).toBe(
      "Bearer synthetic-holded-key",
    );

    nativeFetch.mockClear();
    const unrelatedUrl = "https://api.holded.com/api/v2/contacts?limit=1";
    await globalThis.fetch(unrelatedUrl);
    expect(nativeFetch).toHaveBeenCalledWith(unrelatedUrl, undefined);
  });

  it("gives the standalone process an ephemeral credential key without overriding Holded", async () => {
    const runner = await readFile("scripts/test-e2e.sh", "utf8");

    expect(runner).toMatch(
      /export BOOKING_SECRET_KEY="\$\(node -e '[^']+Buffer\.alloc\(32[^']+'\)"/u,
    );
    expect(runner).not.toMatch(/HOLDED_(?:BASE_)?URL/u);
  });
});