export const HOLDED_TEST_SENTINELS = {
  credential: "holded-test-credential-must-never-leak",
  cursor: "holded-test-cursor-must-never-leak",
  narrative: "Synthetic payer narrative must never leak",
  providerMessage: "Synthetic provider message must never leak",
} as const;

export interface HoldedAccountFixture {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
  [key: string]: unknown;
}

export interface HoldedMovementFixture {
  id: string;
  banking_account_id: string;
  booking_date: string;
  value_date?: string | null;
  description?: string | null;
  amount: string;
  currency: string;
  status?: string | null;
  [key: string]: unknown;
}

export interface HoldedPageFixture<T> {
  items: T[];
  has_more: boolean;
  cursor: string | null;
}

function syntheticHexId(sequence: number) {
  return sequence.toString(16).padStart(24, "0").slice(-24);
}

export function createHoldedTreasuryFixtureScope() {
  let accountSequence = 1;
  let movementSequence = 10_000;
  let cursorSequence = 1;

  function account(overrides: Partial<HoldedAccountFixture> = {}): HoldedAccountFixture {
    const id = overrides.id ?? syntheticHexId(accountSequence++);
    return {
      id,
      name: "Synthetic treasury account",
      currency: "EUR",
      archived: false,
      account_number: "discarded-account-number",
      iban: "discarded-synthetic-iban",
      ...overrides,
    };
  }

  function movement(
    accountId: string,
    overrides: Partial<HoldedMovementFixture> = {},
  ): HoldedMovementFixture {
    const id = overrides.id ?? syntheticHexId(movementSequence++);
    return {
      id,
      banking_account_id: accountId,
      booking_date: "2026-09-16T09:30:00+02:00",
      value_date: "2026-09-16T09:30:00+02:00",
      description: `Synthetic movement ${id}`,
      amount: "125.50",
      currency: "EUR",
      status: "pending",
      balance: "discarded-synthetic-balance",
      ...overrides,
    };
  }

  function page<T>(
    items: T[],
    overrides: Partial<Omit<HoldedPageFixture<T>, "items">> = {},
  ): HoldedPageFixture<T> {
    const hasMore = overrides.has_more ?? false;
    return {
      items,
      has_more: hasMore,
      cursor:
        overrides.cursor === undefined
          ? hasMore
            ? `synthetic-cursor-${cursorSequence++}`
            : null
          : overrides.cursor,
    };
  }

  return { account, movement, page };
}

export function holdedJsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}