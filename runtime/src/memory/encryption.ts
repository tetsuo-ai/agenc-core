/**
 * AES-256-GCM encryption provider for memory backends.
 *
 * Uses only Node.js `crypto` — zero external dependencies.
 *
 * Ciphertext format: base64(iv ∥ authTag ∥ ciphertext)
 *   - iv: 12 bytes
 *   - authTag: 16 bytes
 *   - ciphertext: variable length
 *
 * @module
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MEMORY_OPERATIONAL_LIMITS } from "./types.js";

const IV_BYTES = MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_IV_SIZE_BYTES;
const TAG_BYTES = MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_AUTH_TAG_SIZE_BYTES;
const KEY_BYTES = MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_KEY_SIZE_BYTES;
const ALGORITHM = "aes-256-gcm";

/**
 * Configuration for enabling encryption on a memory backend.
 */
export interface EncryptionConfig {
  /** 32-byte key as a Buffer or hex-encoded string */
  key: Buffer | string;
}

/**
 * Configuration for versioned key rotation.
 * Keys are stored in a map of version → key material.
 * The `currentVersion` is used for new encryptions.
 * Old versions are retained for decryption of existing entries.
 */
interface VersionedEncryptionConfig {
  /** Map of key version → 32-byte key (Buffer or hex string). */
  keys: Record<number, Buffer | string>;
  /** Version to use for new encryptions. */
  currentVersion: number;
}

/**
 * Provider interface for encrypting/decrypting field values.
 */
export interface EncryptionProvider {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * Versioned encryption provider — supports key rotation.
 * New encryptions use the current version key.
 * Decryption detects the version from the ciphertext prefix and uses the matching key.
 */
interface VersionedEncryptionProvider extends EncryptionProvider {
  /** Current key version used for new encryptions. */
  readonly currentVersion: number;
  /** Re-encrypt a value with the current key version. */
  reEncrypt(ciphertext: string): string;
  /** Check if a ciphertext was encrypted with the current version. */
  isCurrentVersion(ciphertext: string): boolean;
}

/**
 * Create an AES-256-GCM encryption provider.
 *
 * @param config - Encryption configuration with a 32-byte key
 * @returns An EncryptionProvider that encrypts/decrypts strings
 * @throws Error if the key is not exactly 32 bytes
 */
export function createAES256GCMProvider(
  config: EncryptionConfig,
): EncryptionProvider {
  const keyBuf =
    typeof config.key === "string"
      ? Buffer.from(config.key, "hex")
      : config.key;

  if (keyBuf.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be exactly ${KEY_BYTES} bytes, got ${keyBuf.length}`,
    );
  }

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      // iv ∥ authTag ∥ ciphertext
      const combined = Buffer.concat([iv, authTag, encrypted]);
      return combined.toString("base64");
    },

    decrypt(ciphertext: string): string {
      const combined = Buffer.from(ciphertext, "base64");

      if (combined.length < IV_BYTES + TAG_BYTES) {
        throw new Error("Ciphertext too short");
      }

      const iv = combined.subarray(0, IV_BYTES);
      const authTag = combined.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const encrypted = combined.subarray(IV_BYTES + TAG_BYTES);

      const decipher = createDecipheriv(ALGORITHM, keyBuf, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    },
  };
}

/**
 * Versioned ciphertext format: base64("V" + version_byte + iv + authTag + ciphertext)
 * The "V" prefix byte distinguishes versioned from non-versioned ciphertexts.
 */
const VERSION_MARKER = 0x56; // ASCII 'V'

/**
 * Create a versioned AES-256-GCM encryption provider for key rotation.
 *
 * Ciphertext format: base64(0x56 + version_u8 + iv + authTag + ciphertext)
 * Non-versioned ciphertexts (from createAES256GCMProvider) are decoded
 * using the version 0 key if available, or the current key as fallback.
 */
export function createVersionedAES256GCMProvider(
  config: VersionedEncryptionConfig,
): VersionedEncryptionProvider {
  const keyMap = new Map<number, Buffer>();
  for (const [vStr, k] of Object.entries(config.keys)) {
    const version = Number(vStr);
    const buf = typeof k === "string" ? Buffer.from(k, "hex") : k;
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `Encryption key version ${version} must be exactly ${KEY_BYTES} bytes, got ${buf.length}`,
      );
    }
    keyMap.set(version, buf);
  }

  const currentVersion = config.currentVersion;
  const currentKeyLookup = keyMap.get(currentVersion);
  if (!currentKeyLookup) {
    throw new Error(
      `Current key version ${currentVersion} not found in key map`,
    );
  }
  const currentKey: Buffer = currentKeyLookup;

  function encryptWithVersion(plaintext: string, version: number, key: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // V + version_byte + iv + authTag + ciphertext
    const combined = Buffer.concat([
      Buffer.from([VERSION_MARKER, version & 0xff]),
      iv,
      authTag,
      encrypted,
    ]);
    return combined.toString("base64");
  }

  function decryptPayload(
    payload: Buffer,
    key: Buffer,
    shortCiphertextError: string,
  ): string {
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new Error(shortCiphertextError);
    }

    const iv = payload.subarray(0, IV_BYTES);
    const authTag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = payload.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  }

  function decryptLegacyPayload(combined: Buffer): string {
    const legacyKey: Buffer = keyMap.get(0) ?? currentKey;
    return decryptPayload(combined, legacyKey, "Ciphertext too short");
  }

  function detectVersionAndDecrypt(ciphertext: string): string {
    const combined = Buffer.from(ciphertext, "base64");

    // Check for version marker
    if (combined.length >= 2 && combined[0] === VERSION_MARKER) {
      const version = combined[1];
      const key = keyMap.get(version);
      const payload = combined.subarray(2);

      if (key) {
        return decryptPayload(payload, key, "Versioned ciphertext too short");
      }

      // Legacy ciphertexts can start with the version marker because their IV is random.
      // Only preserve the unknown-version error when the legacy decode also fails.
      try {
        return decryptLegacyPayload(combined);
      } catch {
        throw new Error(`No key available for version ${version}`);
      }
    }

    return decryptLegacyPayload(combined);
  }

  return {
    currentVersion,

    encrypt(plaintext: string): string {
      return encryptWithVersion(plaintext, currentVersion, currentKey);
    },

    decrypt(ciphertext: string): string {
      return detectVersionAndDecrypt(ciphertext);
    },

    reEncrypt(ciphertext: string): string {
      const plaintext = detectVersionAndDecrypt(ciphertext);
      return encryptWithVersion(plaintext, currentVersion, currentKey);
    },

    isCurrentVersion(ciphertext: string): boolean {
      const combined = Buffer.from(ciphertext, "base64");
      if (combined.length < 2) return false;
      return combined[0] === VERSION_MARKER && combined[1] === currentVersion;
    },
  };
}
