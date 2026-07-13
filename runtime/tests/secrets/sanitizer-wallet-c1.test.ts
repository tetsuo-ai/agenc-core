import { describe, expect, it } from "vitest";

import { REDACTED_SECRET, redactSecrets, redactSecretsInValue } from "./index.js";

// C1 (core-todo.md): redactSecrets left the four highest-value wallet secrets on
// this product unredacted — Solana JSON-array keypairs, PEM private keys, the
// vault passphrase, and uppercase/Title-Case BIP39 phrases. These tests pin the
// fix; they must fail against the pre-fix sanitizer.

// A standard `~/.config/solana/id.json` export is a 64-element JSON array of
// bytes (0-255). Assembled at runtime so scanners don't flag the fixture.
const SOLANA_KEYPAIR_BYTES = Array.from({ length: 64 }, (_v, i) => (i * 37 + 11) % 256);
const SOLANA_KEYPAIR_JSON = `[${SOLANA_KEYPAIR_BYTES.join(",")}]`;
const SOLANA_KEYPAIR_JSON_SPACED = `[${SOLANA_KEYPAIR_BYTES.join(", ")}]`;
// 32-byte secret-scalar form.
const SOLANA_SECRET_32 = `[${SOLANA_KEYPAIR_BYTES.slice(0, 32).join(",")}]`;

const PEM_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
  "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
  "-----END PRIVATE KEY-----",
].join("\n");
const PEM_OPENSSH_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

// BIP39 phrase in ALL CAPS (Ledger recovery sheets are uppercase) and Title Case.
const MNEMONIC_UPPER =
  "LEGAL WINNER THANK YEAR WAVE SAUSAGE WORTH USEFUL LEGAL WINNER THANK YELLOW";
const MNEMONIC_TITLE =
  "Legal Winner Thank Year Wave Sausage Worth Useful Legal Winner Thank Yellow";

describe("secrets sanitizer — C1 wallet-secret gaps", () => {
  it("redacts a Solana JSON-array keypair (64-byte, spaced, and 32-byte forms)", () => {
    for (const form of [SOLANA_KEYPAIR_JSON, SOLANA_KEYPAIR_JSON_SPACED, SOLANA_SECRET_32]) {
      const redacted = redactSecrets(`keypair dump: ${form}`);
      expect(redacted).not.toContain(form);
      expect(redacted).toContain(REDACTED_SECRET);
    }
  });

  it("redacts PEM private-key blocks (PKCS8 and OpenSSH)", () => {
    for (const pem of [PEM_PRIVATE_KEY, PEM_OPENSSH_KEY]) {
      const redacted = redactSecrets(`here is the key:\n${pem}\n`);
      expect(redacted).not.toContain("PRIVATE KEY");
      expect(redacted).not.toContain("MIIEvQIBAD");
      expect(redacted).not.toContain("b3BlbnNzaC");
      expect(redacted).toContain(REDACTED_SECRET);
    }
  });

  it("redacts the vault passphrase env assignment", () => {
    const secret = "hunter2-super-secret-vault-passphrase";
    const redacted = redactSecrets(`export AGENC_WALLET_VAULT_PASSPHRASE=${secret}`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain(REDACTED_SECRET);
  });

  it("leaf-redacts a passphrase field in nested JSON", () => {
    const artifact = {
      AGENC_WALLET_VAULT_PASSPHRASE: "hunter2-super-secret-vault-passphrase",
      note: "kept",
    };
    const redacted = redactSecretsInValue(artifact);
    expect(redacted).toEqual({
      AGENC_WALLET_VAULT_PASSPHRASE: REDACTED_SECRET,
      note: "kept",
    });
  });

  it("redacts BIP39 phrases regardless of letter case", () => {
    for (const phrase of [MNEMONIC_UPPER, MNEMONIC_TITLE]) {
      const redacted = redactSecrets(phrase);
      expect(redacted.toLowerCase()).not.toContain("sausage");
      expect(redacted).toContain(REDACTED_SECRET);
    }
  });

  it("does not over-redact ordinary integer arrays or prose", () => {
    // Short byte arrays and arrays with out-of-range / large integers are not keypairs.
    const benign = 'counts: [1, 2, 3, 4, 5]; ids: [1024, 65535, 300000]; ratio [1,2]';
    expect(redactSecrets(benign)).toBe(benign);
    const prose = "Please deliver the winner list to the legal team this year.";
    expect(redactSecrets(prose)).toBe(prose);
  });
});
