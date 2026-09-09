// @vitest-environment node
import { writeFileSync } from "node:fs";

import { describe, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveIntegration } from "@/modules/booking/services/settings";

const run = process.env.RUN_INTEGRATION_TESTS === "true";

describe.runIf(run)("probe", () => {
  it("tries the last issuing routes and the web url shape", async () => {
    const { secret } = await resolveIntegration("HOLDED");
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    };
    const log: unknown[] = [];

    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* raw */
      }
      log.push({ method, url, status: res.status, body: parsed });
      return { status: res.status, body: parsed as any };
    };

    const v2 = "https://api.holded.com/api/v2";
    const base = {
      contact_id: "6a96988e03f143b43a038c38",
      description: "PROVA TECNICA - esborrar",
      language: "ca",
      tax_included: true,
      items: [{ name: "Prova", units: 1, price: 1, taxes: ["s_iva_10"] }],
    };

    const created = await call("POST", `${v2}/estimates?draft=false`, base);
    const id = created.body?.id as string | undefined;
    if (id) {
      await call("GET", `${v2}/estimates/${id}`);
      await call("DELETE", `${v2}/estimates/${id}`);
    }

    // Is the retired v1 document API reachable with this key at all?
    await call("GET", "https://api.holded.com/api/invoicing/v1/documents/estimate");

    writeFileSync("/tmp/holded-probe.json", JSON.stringify(log, null, 2));
  }, 120_000);
});
