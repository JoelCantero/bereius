// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createHoldedClient, HOLDED_BASE_URL } from "@/lib/holded/client";
import {
  HOLDED_REQUEST_TIMEOUT_MS,
  HOLDED_RESPONSE_LIMIT_BYTES,
  type HoldedBankMovementPayload,
  type HoldedTreasuryAccount,
} from "@/modules/banking/schema";
import { createHttpMailProvider } from "../helpers/http-mail-provider";
import {
  createHoldedTreasuryFixtureScope,
  HOLDED_TEST_SENTINELS,
} from "../helpers/holded-treasury";

interface TreasuryReads {
  listTreasuryAccounts(): Promise<HoldedTreasuryAccount[]>;
  listBankMovements(input: {
    accountId: string;
    startDate: string;
    cursor?: string;
  }): Promise<{
    items: HoldedBankMovementPayload[];
    hasMore: boolean;
    cursor: string | null;
  }>;
}

function treasuryClient(
  behaviors: Parameters<typeof createHttpMailProvider>[0],
) {
  const http = createHttpMailProvider(behaviors);
  const client = createHoldedClient(
    HOLDED_TEST_SENTINELS.credential,
    http.client,
  ) as unknown as TreasuryReads;
  return { client, http };
}

function page(body: unknown, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected request to fail");
  } catch (error) {
    return error as Error & { code?: string };
  }
}

describe("Holded treasury reads", () => {
  it("walks account pages with opaque cursors and strips private fields", async () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const second = fixtures.account({ name: "Second synthetic account" });
    const first = fixtures.account({ name: "First synthetic account" });
    const { client, http } = treasuryClient([
      page(fixtures.page([second], { has_more: true, cursor: "opaque:first/next" })),
      page(fixtures.page([first])),
    ]);

    await expect(client.listTreasuryAccounts()).resolves.toEqual([
      {
        id: second.id,
        name: second.name,
        currency: "EUR",
        archived: false,
      },
      {
        id: first.id,
        name: first.name,
        currency: "EUR",
        archived: false,
      },
    ]);

    expect(http.requests).toHaveLength(2);
    for (const request of http.requests) {
      const url = new URL(request.logicalUrl);
      expect(url.origin + url.pathname).toBe(`${HOLDED_BASE_URL}/treasury/accounts`);
      expect(url.searchParams.get("limit")).toBe("100");
      expect(request.method).toBe("GET");
      expect(request.body).toBeNull();
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${HOLDED_TEST_SENTINELS.credential}`,
      );
    }
    expect(new URL(http.requests[0].logicalUrl).searchParams.has("cursor")).toBe(false);
    expect(new URL(http.requests[1].logicalUrl).searchParams.get("cursor")).toBe(
      "opaque:first/next",
    );
  });

  it("requests the exact bank-movements path and repeats the fixed query", async () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const movement = fixtures.movement(account.id);
    const { client, http } = treasuryClient([
      page(fixtures.page([movement], { has_more: true, cursor: "opaque:next" })),
    ]);

    await expect(
      client.listBankMovements({
        accountId: account.id,
        startDate: "2026-06-18",
        cursor: HOLDED_TEST_SENTINELS.cursor,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: movement.id,
          banking_account_id: account.id,
          booking_date: movement.booking_date,
          value_date: movement.value_date,
          description: movement.description,
          amount: movement.amount,
          currency: movement.currency,
          status: movement.status,
        },
      ],
      hasMore: true,
      cursor: "opaque:next",
    });

    const request = http.requests[0];
    const url = new URL(request.logicalUrl);
    expect(url.origin + url.pathname).toBe(
      `${HOLDED_BASE_URL}/treasury/accounts/${account.id}/bank-movements`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start_date: "2026-06-18",
      limit: "100",
      cursor: HOLDED_TEST_SENTINELS.cursor,
    });
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
  });

  it("does not require provider items to arrive in identifier order", async () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const laterId = fixtures.movement(account.id, { id: "ffffffffffffffffffffffff" });
    const earlierId = fixtures.movement(account.id, { id: "000000000000000000000001" });
    const { client } = treasuryClient([
      page(fixtures.page([laterId, earlierId])),
    ]);

    const result = await client.listBankMovements({
      accountId: account.id,
      startDate: "2026-06-18",
    });

    expect(result.items.map((item) => item.id)).toEqual([
      laterId.id,
      earlierId.id,
    ]);
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [429, "rate_limited"],
    [400, "invalid_request"],
    [422, "invalid_request"],
    [503, "unavailable"],
  ] as const)("maps HTTP %i without retaining its body", async (status, code) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const { client } = treasuryClient([
      page({ message: HOLDED_TEST_SENTINELS.providerMessage }, status),
    ]);

    const error = await errorOf(
      client.listBankMovements({
        accountId: account.id,
        startDate: "2026-06-18",
      }),
    );

    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain(HOLDED_TEST_SENTINELS.providerMessage);
    expect(error.message).not.toContain(HOLDED_TEST_SENTINELS.providerMessage);
  });

  it("maps transport failure without copying its message", async () => {
    const providerMessage = HOLDED_TEST_SENTINELS.providerMessage;
    const { client } = treasuryClient([{ error: new Error(providerMessage) }]);

    const error = await errorOf(client.listTreasuryAccounts());

    expect(error).toMatchObject({ code: "unavailable" });
    expect(error.message).not.toContain(providerMessage);
  });

  it("distinguishes an oversized response from malformed JSON", async () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const oversized = "x".repeat(HOLDED_RESPONSE_LIMIT_BYTES + 1);
    const { client } = treasuryClient([
      page({ items: [], has_more: false, cursor: null, oversized }),
    ]);

    await expect(
      client.listBankMovements({
        accountId: account.id,
        startDate: "2026-06-18",
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it.each([
    { items: [], has_more: true, cursor: null },
    { items: [], has_more: "false", cursor: null },
    { items: {}, has_more: false, cursor: null },
    "not-an-envelope",
  ])("rejects malformed success envelopes", async (body) => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const { client } = treasuryClient([page(body)]);

    await expect(
      client.listBankMovements({
        accountId: account.id,
        startDate: "2026-06-18",
      }),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects repeated account cursors rather than looping", async () => {
    const fixtures = createHoldedTreasuryFixtureScope();
    const account = fixtures.account();
    const repeated = fixtures.page([account], {
      has_more: true,
      cursor: "same-cursor",
    });
    const { client, http } = treasuryClient([page(repeated), page(repeated)]);

    await expect(client.listTreasuryAccounts()).rejects.toMatchObject({
      code: "malformed_response",
    });
    expect(http.requests).toHaveLength(2);
  });

  it("keeps treasury operations read-only and uses the shared timeout", () => {
    const { client } = treasuryClient([]);

    expect(HOLDED_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect("createTreasuryAccount" in client).toBe(false);
    expect("updateTreasuryAccount" in client).toBe(false);
    expect("createBankMovement" in client).toBe(false);
    expect("updateBankMovement" in client).toBe(false);
    expect("deleteBankMovement" in client).toBe(false);
  });
});