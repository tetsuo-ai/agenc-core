import { randomBytes } from "node:crypto";

import type { HomeContext } from "../../config/home.js";
import type { SecureStorageData } from "./index.js";
import { updateNativeSecureStorage } from "./native.js";

/** Shortest value accepted as a surface bearer token, explicit or stored. */
const MIN_SURFACE_TOKEN_LENGTH = 16;

/** Where one generated surface token lives inside the shared native record. */
export interface GeneratedSurfaceTokenSlot {
  /** The stored token, when the record holds one. */
  read(current: Readonly<SecureStorageData>): string | undefined;
  /** The record with this token stored and every other field left alone. */
  write(
    current: Readonly<SecureStorageData>,
    token: string,
  ): SecureStorageData;
  /** Leads the error raised when native secure storage cannot be used. */
  readonly unavailableMessage: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the bearer token of a loopback surface. An explicit environment
 * value of at least 16 characters wins and is never persisted. Otherwise the
 * token is generated once and kept in the home-bound native secure storage,
 * inside one serialized read-modify-write so every process agrees on it.
 */
export function resolveGeneratedSurfaceToken(
  home: HomeContext,
  slot: GeneratedSurfaceTokenSlot,
  environmentValue: string | undefined,
): string {
  const explicit = nonEmpty(environmentValue);
  if (explicit !== undefined && explicit.length >= MIN_SURFACE_TOKEN_LENGTH) {
    return explicit;
  }

  let resolved: string | undefined;
  updateNativeSecureStorage(
    home,
    (current) => {
      const existing = nonEmpty(slot.read(current));
      resolved =
        existing !== undefined && existing.length >= MIN_SURFACE_TOKEN_LENGTH
          ? existing
          : randomBytes(24).toString("base64url");
      if (existing === resolved) return structuredClone(current);
      return slot.write(current, resolved);
    },
    slot.unavailableMessage,
  );
  if (resolved === undefined) {
    throw new Error("Surface token resolution completed without a token");
  }
  return resolved;
}
