// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const key = Buffer.alloc(32, 3);

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ BOOKING: { secretKey: key } }),
}));

import {
  BookingSecretError,
  isSecretStorageAvailable,
  openSecret,
  sealSecret,
} from "@/lib/booking/secrets";
import {
  STORED_SECRET_PLACEHOLDER,
  submittedSecret,
} from "@/modules/booking/schema";

describe("booking secret storage", () => {
  it("round-trips a credential", () => {
    const secret = "holded-api-key-value";

    expect(openSecret(sealSecret(secret))).toBe(secret);
  });

  it("never stores the plaintext in the ciphertext", () => {
    const secret = "gravity-forms-consumer-secret";
    const sealed = sealSecret(secret);
    const ciphertext = Buffer.from(sealed.ciphertext);

    expect(ciphertext.toString("utf8")).not.toContain(secret);
    expect(ciphertext.toString("base64")).not.toContain(
      Buffer.from(secret).toString("base64"),
    );
  });

  it("produces a different ciphertext each time, so equal secrets are not comparable", () => {
    const first = sealSecret("same-secret");
    const second = sealSecret("same-secret");

    expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false);
    expect(
      Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext)),
    ).toBe(false);
  });

  it("refuses a tampered ciphertext instead of returning something plausible", () => {
    const sealed = sealSecret("smtp-password");
    const tampered = Uint8Array.from(sealed.ciphertext);
    tampered[0] ^= 0xff;

    expect(() => openSecret({ ...sealed, ciphertext: tampered })).toThrow(
      BookingSecretError,
    );
  });

  it("refuses a tampered authentication tag", () => {
    const sealed = sealSecret("smtp-password");
    const tampered = Uint8Array.from(sealed.authTag);
    tampered[0] ^= 0xff;

    expect(() => openSecret({ ...sealed, authTag: tampered })).toThrow(
      BookingSecretError,
    );
  });

  it("refuses a ciphertext opened with the wrong nonce", () => {
    const sealed = sealSecret("bank-private-key");

    expect(() =>
      openSecret({ ...sealed, iv: Uint8Array.from(Buffer.alloc(12, 9)) }),
    ).toThrow(BookingSecretError);
  });

  it("reports storage as available when a key is configured", () => {
    expect(isSecretStorageAvailable()).toBe(true);
  });

  it("keeps the credential out of the error it throws", () => {
    const sealed = sealSecret("super-secret-credential");
    const tampered = Uint8Array.from(sealed.ciphertext);
    tampered[0] ^= 0xff;

    try {
      openSecret({ ...sealed, ciphertext: tampered });
      expect.unreachable("expected decryption to fail");
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-credential");
    }
  });
});

describe("credential submissions from the settings screen", () => {
  it("reads the placeholder as leave the stored credential alone", () => {
    expect(submittedSecret(STORED_SECRET_PLACEHOLDER)).toBeUndefined();
  });

  it.each([undefined, "", "   "])("treats %o as no change", (value) => {
    expect(submittedSecret(value)).toBeUndefined();
  });

  it("accepts a genuine replacement", () => {
    expect(submittedSecret("  new-api-key  ")).toBe("new-api-key");
  });
});
