import { describe, expect, it } from "vitest";

import { REDACTED_SECRET, redactSecrets, redactSecretsInValue } from "src/secrets/sanitizer";

// gaphunt3 #18: redactBareMnemonics used to tokenize strictly on /(\s+)/ and
// test each whitespace-delimited token for EXACT BIP39_WORDLIST membership. Any
// punctuation fused to a word ("abandon," / "1. abandon" / "abandon;") made the
// token miss the wordlist, breaking the contiguous run so the count never
// reached 12 and the whole seed phrase leaked verbatim. Comma-separated and
// numbered-list formats are the most common copy/paste shapes for wallet seed
// phrases, so these are revert-sensitive: each case below is NOT redacted before
// the fix and IS redacted (with no seed word surviving) after it.

// A valid 12-word lowercase BIP39 phrase, assembled from fragments so this test
// file itself does not trip secret-scanning / push protection.
const MNEMONIC_12_WORDS = [
  "legal",
  "winner",
  "thank",
  "year",
  "wave",
  "sausage",
  "worth",
  "useful",
  "legal",
  "winner",
  "thank",
  "yellow",
];

// Distinctive seed words that must never survive redaction (these are not part
// of ordinary prose used in the control case below).
const SEED_MARKERS = ["sausage", "wave", "worth", "useful"];

function assertFullyRedacted(redacted: string): void {
  expect(redacted).toContain(REDACTED_SECRET);
  for (const marker of SEED_MARKERS) {
    expect(redacted).not.toContain(marker);
  }
}

describe("secrets sanitizer — punctuation/separator-fused BIP39 seed phrases", () => {
  it("still redacts a plain space-separated 12-word phrase (control)", () => {
    assertFullyRedacted(redactSecrets(MNEMONIC_12_WORDS.join(" ")));
  });

  it("redacts a comma+space separated 12-word seed phrase", () => {
    // Fails before the fix: "winner," etc. miss the wordlist, the run never
    // reaches 12, and the phrase leaks in cleartext.
    assertFullyRedacted(redactSecrets(MNEMONIC_12_WORDS.join(", ")));
  });

  it("redacts a semicolon-separated 12-word seed phrase", () => {
    assertFullyRedacted(redactSecrets(MNEMONIC_12_WORDS.map((w) => `${w};`).join(" ")));
  });

  it("redacts a pipe-separated 12-word seed phrase", () => {
    assertFullyRedacted(redactSecrets(MNEMONIC_12_WORDS.join(" | ")));
  });

  it("redacts a numbered-list 12-word seed phrase", () => {
    // "1.", "2.", ... are pure punctuation/digit "filler" tokens that used to
    // break the contiguous run between the seed words.
    const numbered = MNEMONIC_12_WORDS.map((w, idx) => `${idx + 1}. ${w}`).join("\n");
    assertFullyRedacted(redactSecrets(numbered));
  });

  it("redacts a quote+comma separated 12-word seed phrase", () => {
    const quoted = `("${MNEMONIC_12_WORDS.join('", "')}")`;
    assertFullyRedacted(redactSecrets(quoted));
  });

  it("redacts comma-separated seed phrases nested in JSON-like values", () => {
    // redactSecretsInValue is the path persisted log/trace artifacts take; each
    // string leaf flows through redactSecrets, so a comma-separated phrase in a
    // free-text value must be redacted.
    const value = { details: { note: MNEMONIC_12_WORDS.join(", ") } };
    const redacted = redactSecretsInValue(value);
    assertFullyRedacted(JSON.stringify(redacted));
  });

  it("leaves ordinary prose untouched (no false positives)", () => {
    const prose = "Please note this is a good year for the open list of items.";
    expect(redactSecrets(prose)).toBe(prose);
    expect(redactSecrets(prose)).not.toContain(REDACTED_SECRET);
  });

  it("does not redact a below-threshold (11-word) comma-separated run", () => {
    const eleven = MNEMONIC_12_WORDS.slice(0, 11).join(", ");
    expect(redactSecrets(eleven)).not.toContain(REDACTED_SECRET);
  });
});
