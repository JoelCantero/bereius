// @vitest-environment node

import type { DestinationStream } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createLogger } from "@/lib/logger";
import { projectBankSyncIncident } from "@/modules/banking/services/queries";

describe("banking observability", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = {
      ...originalEnv,
      PROJECT_NAME: "banking-observability-test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
      AUTH_SECRET: "banking-observability-auth-secret-32-chars",
      NEXTAUTH_URL: "https://app.example.test",
      NODE_ENV: "test",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("redacts banking provider and financial fields while preserving operational signals", () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(chunk);
      },
    };
    const logger = createLogger(process.env, destination);
    const forbidden = {
      credential: "private-holded-credential",
      holdedAccountId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      holdedMovementId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      cursor: "private-provider-cursor",
      nextCursor: "private-next-cursor",
      bookingDate: "2042-01-02-private-booking-date",
      valueDate: "2042-01-03-private-value-date",
      importStartDate: "2042-01-04-private-import-date",
      windowStartDate: "2042-01-05-private-window-date",
      amount: "123456.78-private-amount",
      amountMinor: "12345678-private-minor-units",
      balance: "999999-private-balance",
      narrative: "Private payer narrative",
      reference: "Private bank reference",
      counterparty: "Private Counterparty",
      rawBody: "private raw Holded body",
      providerMessage: "private provider failure detail",
    };

    logger.info(
      {
        event: "bank_sync_page_committed",
        runId: "local-run-id",
        accountId: "local-account-row-id",
        status: "PARTIAL",
        pageCount: 2,
        itemCount: 100,
        banking: forbidden,
      },
      "banking operation",
    );

    const serialized = lines.at(-1)!;
    for (const value of Object.values(forbidden)) {
      expect(serialized).not.toContain(value);
    }
    expect(JSON.parse(serialized)).toMatchObject({
      event: "bank_sync_page_committed",
      runId: "local-run-id",
      accountId: "local-account-row-id",
      status: "PARTIAL",
      pageCount: 2,
      itemCount: 100,
    });
  });

  it("projects incidents through an explicit non-personal whitelist", () => {
    const storedIncident = {
      code: "INVALID_AMOUNT" as const,
      pageNumber: 3,
      itemIndex: 7,
      holdedMovementId: "cccccccccccccccccccccccc",
      createdAt: new Date("2042-02-01T00:00:00.000Z"),
      amountMinor: "private-amount",
      narrative: "private narrative",
      reference: "private reference",
      counterparty: "private counterparty",
      providerMessage: "private provider message",
      rawBody: "private body",
      nextCursor: "private cursor",
    };

    const projected = projectBankSyncIncident(storedIncident);

    expect(projected).toEqual({
      code: "INVALID_AMOUNT",
      pageNumber: 3,
      itemIndex: 7,
    });
    const serialized = JSON.stringify(projected);
    for (const value of Object.values(storedIncident)) {
      if (value === storedIncident.code || typeof value === "number") continue;
      expect(serialized).not.toContain(String(value));
    }
  });
});