import { describe, expect, it } from "vitest";

import { REDACTED_SECRET, redactSecrets, redactSecretsInValue } from "./index.js";

// Fixtures are assembled so secret-scanning / push-protection does not flag the
// test file, while the runtime values still match the sanitizer patterns.
// 88-char base58 (no 0/O/I/l) standing in for an exported ed25519 secret key.
const BASE58_SECRET_KEY =
  "4wBqpZ" + "M9k7Tj2RhYcVnDxLgUaSeF3bN8pQ6vWmJ5zKtCrXyHd1Ag7uPo2EiBsLn4Qw3Rf6Tz9YvMk8Hb2Cd5Ne";
// A genuine 12-word BIP39 phrase shape (all valid-length lowercase words).
const MNEMONIC_12 =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const MNEMONIC_24 =
  "legal winner thank year wave sausage worth useful legal winner thank yellow " +
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("secrets sanitizer — wallet key material", () => {
  it("redacts wallet key names in flat string assignments (snake + camel)", () => {
    const input = [
      "private_key=opaque-value-12345",
      "privateKey: opaque-value-12345",
      "signing_key = opaque-value-12345",
      "signingKey=opaque-value-12345",
      "mnemonic=opaque-value-12345",
      "seed_phrase: opaque-value-12345",
      "seedPhrase=opaque-value-12345",
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain("opaque-value-12345");
    expect(redacted).toContain(`private_key=${REDACTED_SECRET}`);
    expect(redacted).toContain(`privateKey: ${REDACTED_SECRET}`);
    expect(redacted).toContain(`signing_key = ${REDACTED_SECRET}`);
    expect(redacted).toContain(`signingKey=${REDACTED_SECRET}`);
    expect(redacted).toContain(`mnemonic=${REDACTED_SECRET}`);
    expect(redacted).toContain(`seed_phrase: ${REDACTED_SECRET}`);
    expect(redacted).toContain(`seedPhrase=${REDACTED_SECRET}`);
  });

  it("redacts wallet key names in quoted JSON assignments", () => {
    const input = [
      '{"private_key":"opaque-value-12345"}',
      '{"privateKey":"opaque-value-12345"}',
      '{"mnemonic":"opaque-value-12345"}',
      '{"seed_phrase":"opaque-value-12345"}',
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain("opaque-value-12345");
    expect(redacted).toContain(`"private_key":"${REDACTED_SECRET}"`);
    expect(redacted).toContain(`"privateKey":"${REDACTED_SECRET}"`);
    expect(redacted).toContain(`"mnemonic":"${REDACTED_SECRET}"`);
    expect(redacted).toContain(`"seed_phrase":"${REDACTED_SECRET}"`);
  });

  it("redacts a bare base58 secret-key value lacking any key context", () => {
    const redacted = redactSecrets(`key dump: ${BASE58_SECRET_KEY}`);
    expect(redacted).not.toContain(BASE58_SECRET_KEY);
    expect(redacted).toContain(REDACTED_SECRET);
  });

  it("redacts bare BIP39 12- and 24-word mnemonic values", () => {
    expect(redactSecrets(MNEMONIC_12)).not.toContain("sausage");
    expect(redactSecrets(MNEMONIC_12)).toContain(REDACTED_SECRET);
    expect(redactSecrets(MNEMONIC_24)).not.toContain("sausage");
    expect(redactSecrets(MNEMONIC_24)).toContain(REDACTED_SECRET);
  });

  it("redacts wallet key material in nested JSON artifacts", () => {
    const artifact = {
      wallet: {
        privateKey: BASE58_SECRET_KEY,
        private_key: "opaque-value-12345",
        signingKey: "opaque-value-12345",
        mnemonic: MNEMONIC_12,
        seed_phrase: MNEMONIC_24,
      },
      // False-positive guards: non-secret neighbours stay visible.
      publicKey: "ssh-rsa AAAAB3NzaC1yc2EexamplePublicKeyMaterial",
      randomSeed: 42,
    };

    const redacted = redactSecretsInValue(artifact);

    expect(redacted).toEqual({
      wallet: {
        privateKey: REDACTED_SECRET,
        private_key: REDACTED_SECRET,
        signingKey: REDACTED_SECRET,
        mnemonic: REDACTED_SECRET,
        seed_phrase: REDACTED_SECRET,
      },
      publicKey: "ssh-rsa AAAAB3NzaC1yc2EexamplePublicKeyMaterial",
      randomSeed: 42,
    });
  });

  it("does not over-redact ordinary prose or short word runs", () => {
    const prose = [
      "The quick brown fox jumps over the lazy dog while the team waits",
      "She said the seed of the idea was planted during the first meeting",
      "randomSeed counter is forty two and the public key stays visible",
    ].join("\n");

    const redacted = redactSecrets(prose);

    expect(redacted).toBe(prose);
    expect(redacted).not.toContain(REDACTED_SECRET);
  });
});
