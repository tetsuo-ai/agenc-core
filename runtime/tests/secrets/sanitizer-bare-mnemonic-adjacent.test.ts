import { describe, expect, it } from "vitest";

import { REDACTED_SECRET, redactSecrets } from "./index.js";

// Revert-sensitive regression for the bare-mnemonic leak: a complete BIP39 seed
// phrase that abuts an ordinary BIP39 word (hundreds of common English words —
// "gas", "note", "this", "year", ... — are themselves wordlist members) used to
// extend the contiguous run past a canonical mnemonic length (12 -> 13,
// 24 -> 25). The old code only redacted when the run length was EXACTLY
// 12/15/18/21/24, so the whole phrase — including the seed words — leaked
// verbatim into logs/transcripts/traces. The fix redacts the maximal run once it
// reaches a mnemonic length, so no seed word survives regardless of where the
// extra wordlist words sit.

// Valid-length lowercase BIP39 phrases assembled from fragments so the test file
// itself does not trip secret-scanning / push protection.
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
const MNEMONIC_12 = MNEMONIC_12_WORDS.join(" ");
const MNEMONIC_24 = `${MNEMONIC_12} ${MNEMONIC_12}`;

// A distinctive seed word that must never survive redaction.
const SEED_MARKER = "sausage";

describe("secrets sanitizer — bare mnemonic adjacent to wordlist prose", () => {
  it("redacts a 24-word seed phrase preceded by an ordinary BIP39 word", () => {
    // "gas" is a BIP39 word; it extends the run to 25 and used to defeat
    // redaction entirely.
    const redacted = redactSecrets(`gas ${MNEMONIC_24}`);

    expect(redacted).toContain(REDACTED_SECRET);
    expect(redacted).not.toContain(SEED_MARKER);
    for (const word of MNEMONIC_12_WORDS) {
      // No seed word may appear verbatim after redaction.
      expect(redacted.split(/\s+/)).not.toContain(word);
    }
  });

  it("redacts a 24-word seed phrase followed by an ordinary BIP39 word", () => {
    // "note" and "this" are BIP39 words; "down" is not, so it legitimately
    // survives while every seed word must be gone.
    const redacted = redactSecrets(`${MNEMONIC_24} note this down`);

    expect(redacted).toContain(REDACTED_SECRET);
    expect(redacted).not.toContain(SEED_MARKER);
    expect(redacted).toContain("down");
  });

  it("redacts a 12-word seed phrase abutting an ordinary BIP39 word", () => {
    expect(redactSecrets(`${MNEMONIC_12} note`)).not.toContain(SEED_MARKER);
    expect(redactSecrets(`gas ${MNEMONIC_12}`)).not.toContain(SEED_MARKER);
    expect(redactSecrets(`gas ${MNEMONIC_12}`)).toContain(REDACTED_SECRET);
  });

  it("still redacts an isolated 24-word seed phrase (control)", () => {
    expect(redactSecrets(MNEMONIC_24)).toBe(REDACTED_SECRET);
  });

  it("leaves ordinary prose with only short wordlist runs untouched", () => {
    const prose = "Please note this is a good year for the open list of items.";
    expect(redactSecrets(prose)).toBe(prose);
    expect(redactSecrets(prose)).not.toContain(REDACTED_SECRET);
  });
});
