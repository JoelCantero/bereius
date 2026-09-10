import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getEnv } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/** Uint8Array rather than Buffer, to match how Prisma types a `Bytes` column. */
export interface SealedSecret {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
}

export class BookingSecretError extends Error {
  constructor(
    readonly code: "key_missing" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "BookingSecretError";
  }
}

function requireKey(): Buffer {
  const key = getEnv().BOOKING.secretKey;
  if (!key) {
    throw new BookingSecretError(
      "key_missing",
      "BOOKING_SECRET_KEY is not configured, so booking credentials cannot be stored",
    );
  }
  return key;
}

export function isSecretStorageAvailable(): boolean {
  return getEnv().BOOKING.secretKey !== null;
}

export function sealSecret(plaintext: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, requireKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: Uint8Array.from(ciphertext),
    iv: Uint8Array.from(iv),
    authTag: Uint8Array.from(cipher.getAuthTag()),
  };
}

/**
 * Fails closed: a wrong key or a tampered ciphertext raises rather than
 * returning something that looks like a credential.
 */
export function openSecret(sealed: SealedSecret): string {
  const decipher = createDecipheriv(ALGORITHM, requireKey(), sealed.iv);
  decipher.setAuthTag(sealed.authTag);

  try {
    return Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new BookingSecretError(
      "unreadable",
      "Stored credential could not be decrypted with the configured key",
    );
  }
}
