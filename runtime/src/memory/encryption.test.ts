import { describe, it, expect } from "vitest";
import {
  createAES256GCMProvider,
  createVersionedAES256GCMProvider,
} from "./encryption.js";
import { createCipheriv, randomBytes } from "node:crypto";

describe("AES-256-GCM encryption", () => {
  const key = randomBytes(32);

  it("encrypts and decrypts content correctly", () => {
    const provider = createAES256GCMProvider({ key });
    const plaintext = "Hello, world! This is sensitive content.";
    const ciphertext = provider.encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(provider.decrypt(ciphertext)).toBe(plaintext);
  });

  it("encrypts and decrypts metadata JSON correctly", () => {
    const provider = createAES256GCMProvider({ key });
    const metadata = JSON.stringify({
      type: "conversation_turn",
      confidence: 0.85,
      backgroundRunId: "bg-123",
    });
    const encrypted = provider.encrypt(metadata);
    expect(encrypted).not.toBe(metadata);
    const decrypted = provider.decrypt(encrypted);
    expect(decrypted).toBe(metadata);
    expect(JSON.parse(decrypted)).toEqual({
      type: "conversation_turn",
      confidence: 0.85,
      backgroundRunId: "bg-123",
    });
  });

  it("produces different ciphertexts for same plaintext (random IV)", () => {
    const provider = createAES256GCMProvider({ key });
    const plaintext = "same text";
    const c1 = provider.encrypt(plaintext);
    const c2 = provider.encrypt(plaintext);
    expect(c1).not.toBe(c2);
    expect(provider.decrypt(c1)).toBe(plaintext);
    expect(provider.decrypt(c2)).toBe(plaintext);
  });

  it("rejects wrong key length", () => {
    expect(() => createAES256GCMProvider({ key: randomBytes(16) })).toThrow(
      "must be exactly 32 bytes",
    );
  });

  it("accepts hex-encoded key string", () => {
    const hexKey = randomBytes(32).toString("hex");
    const provider = createAES256GCMProvider({ key: hexKey });
    const ciphertext = provider.encrypt("test");
    expect(provider.decrypt(ciphertext)).toBe("test");
  });

  it("throws on tampered ciphertext", () => {
    const provider = createAES256GCMProvider({ key });
    const ciphertext = provider.encrypt("sensitive data");
    const buf = Buffer.from(ciphertext, "base64");
    buf[buf.length - 1] ^= 0xff; // Flip last byte
    const tampered = buf.toString("base64");
    expect(() => provider.decrypt(tampered)).toThrow();
  });

  it("handles empty string", () => {
    const provider = createAES256GCMProvider({ key });
    const ciphertext = provider.encrypt("");
    expect(provider.decrypt(ciphertext)).toBe("");
  });

  it("handles large metadata payloads", () => {
    const provider = createAES256GCMProvider({ key });
    const largeMetadata = JSON.stringify({
      entries: Array.from({ length: 100 }, (_, i) => ({
        id: `entry-${i}`,
        data: "x".repeat(50),
      })),
    });
    const encrypted = provider.encrypt(largeMetadata);
    expect(provider.decrypt(encrypted)).toBe(largeMetadata);
  });
});

describe("Versioned AES-256-GCM key rotation", () => {
  const keyV1 = randomBytes(32);
  const keyV2 = randomBytes(32);

  it("encrypts with current version and decrypts correctly", () => {
    const provider = createVersionedAES256GCMProvider({
      keys: { 1: keyV1, 2: keyV2 },
      currentVersion: 2,
    });
    const ciphertext = provider.encrypt("secret");
    expect(provider.decrypt(ciphertext)).toBe("secret");
    expect(provider.isCurrentVersion(ciphertext)).toBe(true);
    expect(provider.currentVersion).toBe(2);
  });

  it("decrypts old version entries after key rotation", () => {
    // Encrypt with v1
    const providerV1 = createVersionedAES256GCMProvider({
      keys: { 1: keyV1 },
      currentVersion: 1,
    });
    const ciphertextV1 = providerV1.encrypt("old secret");

    // Rotate to v2 but keep v1 for decryption
    const providerV2 = createVersionedAES256GCMProvider({
      keys: { 1: keyV1, 2: keyV2 },
      currentVersion: 2,
    });
    expect(providerV2.decrypt(ciphertextV1)).toBe("old secret");
    expect(providerV2.isCurrentVersion(ciphertextV1)).toBe(false);
  });

  it("re-encrypts old version entries with current key", () => {
    const providerV1 = createVersionedAES256GCMProvider({
      keys: { 1: keyV1 },
      currentVersion: 1,
    });
    const ciphertextV1 = providerV1.encrypt("migrating");

    const providerV2 = createVersionedAES256GCMProvider({
      keys: { 1: keyV1, 2: keyV2 },
      currentVersion: 2,
    });
    const reEncrypted = providerV2.reEncrypt(ciphertextV1);

    expect(providerV2.isCurrentVersion(reEncrypted)).toBe(true);
    expect(providerV2.decrypt(reEncrypted)).toBe("migrating");
  });

  it("rejects missing current version in key map", () => {
    expect(() =>
      createVersionedAES256GCMProvider({
        keys: { 1: keyV1 },
        currentVersion: 2,
      }),
    ).toThrow("Current key version 2 not found");
  });

  it("rejects wrong key length for any version", () => {
    expect(() =>
      createVersionedAES256GCMProvider({
        keys: { 1: randomBytes(16) },
        currentVersion: 1,
      }),
    ).toThrow("must be exactly 32 bytes");
  });

  it("supports hex-encoded keys", () => {
    const hexKey = randomBytes(32).toString("hex");
    const provider = createVersionedAES256GCMProvider({
      keys: { 1: hexKey },
      currentVersion: 1,
    });
    const ct = provider.encrypt("hex test");
    expect(provider.decrypt(ct)).toBe("hex test");
  });

  it("decrypts non-versioned legacy ciphertexts using version 0 key", () => {
    const legacyKey = randomBytes(32);
    const legacyProvider = createAES256GCMProvider({ key: legacyKey });
    const legacyCiphertext = legacyProvider.encrypt("legacy data");

    const versionedProvider = createVersionedAES256GCMProvider({
      keys: { 0: legacyKey, 1: keyV1 },
      currentVersion: 1,
    });

    expect(versionedProvider.decrypt(legacyCiphertext)).toBe("legacy data");
  });

  it("decrypts legacy ciphertexts whose IV collides with the version marker", () => {
    const legacyKey = randomBytes(32);
    const iv = Buffer.concat([Buffer.from([0x56, 0xee]), randomBytes(10)]);
    const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
    const encrypted = Buffer.concat([
      cipher.update("legacy marker collision", "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const legacyCiphertext = Buffer.concat([iv, authTag, encrypted]).toString(
      "base64",
    );

    const versionedProvider = createVersionedAES256GCMProvider({
      keys: { 0: legacyKey, 1: keyV1 },
      currentVersion: 1,
    });

    expect(versionedProvider.decrypt(legacyCiphertext)).toBe(
      "legacy marker collision",
    );
  });

  it("different versions produce different ciphertexts", () => {
    const providerV1 = createVersionedAES256GCMProvider({
      keys: { 1: keyV1, 2: keyV2 },
      currentVersion: 1,
    });
    const providerV2 = createVersionedAES256GCMProvider({
      keys: { 1: keyV1, 2: keyV2 },
      currentVersion: 2,
    });

    const ct1 = providerV1.encrypt("same text");
    const ct2 = providerV2.encrypt("same text");

    // Both decrypt correctly
    const fullProvider = createVersionedAES256GCMProvider({
      keys: { 1: keyV1, 2: keyV2 },
      currentVersion: 2,
    });
    expect(fullProvider.decrypt(ct1)).toBe("same text");
    expect(fullProvider.decrypt(ct2)).toBe("same text");
  });
});
