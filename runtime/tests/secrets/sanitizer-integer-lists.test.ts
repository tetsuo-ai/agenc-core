import { describe, expect, it } from "vitest";

import {
  REDACTED_SECRET,
  redactSecrets,
  redactSecretsInValue,
} from "../../src/secrets/sanitizer.js";

// #2476: the sanitizer redacted every textual bracketed list of 32–200 bytes
// as wallet key material, erasing benign 80/100-element index permutations
// from durable tool history. These tests pin the documented classification
// policy in `sanitizer.ts`:
//   - a list whose length is not a raw ed25519 encoding (32 or 64) is benign
//     and preserved byte-for-byte;
//   - a 32/64-element unsigned-byte list is ambiguous and redacted (fail
//     closed) regardless of any cosmetic label in the surrounding text;
//   - a list labelled by a sensitive key name is redacted at any length;
//   - numeric JSON arrays are structural provenance and are preserved under
//     ordinary keys.
// All key-shaped fixtures are synthetic and assembled at runtime.

const permutation = (length: number): number[] =>
  Array.from({ length }, (_v, i) => i);

const syntheticBytes = (length: number): number[] =>
  Array.from({ length }, (_v, i) => (i * 37 + 11) % 256);

const compact = (values: readonly number[]): string => `[${values.join(",")}]`;
const spaced = (values: readonly number[]): string => `[${values.join(", ")}]`;
const multiline = (values: readonly number[]): string =>
  `[\n  ${values.join(",\n  ")}\n]`;

const BENIGN_LENGTHS = [31, 33, 63, 65, 79, 80, 100, 199, 200, 201] as const;
const AMBIGUOUS_LENGTHS = [32, 64] as const;

describe("secrets sanitizer — integer-list classification (#2476)", () => {
  it("reproduces the issue: the 80-element permutation string stays intact", () => {
    const numbers = permutation(80);
    const input = `permutation = ${JSON.stringify(numbers)}`;
    expect(redactSecrets(input)).toBe(input);
    expect(redactSecretsInValue({ stdout: input })).toEqual({ stdout: input });
    expect(redactSecretsInValue({ values: numbers })).toEqual({ values: numbers });
  });

  it("keeps the benchmark-shaped T[:100] / invT[:80] stdout byte-for-byte", () => {
    const stdout = [
      `T[:100] ${compact(permutation(100))}`,
      "is T a perm of 0..M-1? True",
      `invT[:80] (source for each output position of delayed stream) ${spaced(permutation(80))}`,
      `offsets ${compact(permutation(80).map((v) => v - 40))}`,
    ].join("\n");
    expect(redactSecrets(stdout)).toBe(stdout);
    expect(redactSecretsInValue({ result: { stdout, exitCode: 0 } })).toEqual({
      result: { stdout, exitCode: 0 },
    });
  });

  it.each(BENIGN_LENGTHS)(
    "preserves a %i-element byte list in compact, spaced and multiline form",
    (length) => {
      for (const render of [compact, spaced, multiline]) {
        for (const values of [permutation(length).map((v) => v % 256), syntheticBytes(length)]) {
          const input = `data = ${render(values)} done`;
          expect(redactSecrets(input)).toBe(input);
        }
      }
    },
  );

  it.each(AMBIGUOUS_LENGTHS)(
    "redacts an unlabelled %i-element unsigned-byte list in every form (fail closed)",
    (length) => {
      for (const render of [compact, spaced, multiline]) {
        const list = render(syntheticBytes(length));
        const redacted = redactSecrets(`keypair dump: ${list}`);
        expect(redacted).toBe(`keypair dump: ${REDACTED_SECRET}`);
      }
    },
  );

  it.each(AMBIGUOUS_LENGTHS)(
    "does not let a cosmetic label exempt a %i-element byte list",
    (length) => {
      const values = syntheticBytes(length);
      for (const label of [
        "permutation = ",
        `T[:${length}] `,
        "# benign analytical output: ",
        "counts: ",
        "histogram=",
        "",
      ]) {
        const redacted = redactSecrets(`${label}${compact(values)}`);
        expect(redacted).toBe(`${label}${REDACTED_SECRET}`);
        expect(redacted).not.toContain(values.slice(0, 8).join(","));
      }
    },
  );

  it("redacts a 32/64 list even when it is a perfect permutation of small indexes", () => {
    // Ambiguity is by length and value range, not by how "random" the values
    // look: a permutation of 0..31 and a secret scalar are the same text.
    for (const length of AMBIGUOUS_LENGTHS) {
      expect(redactSecrets(`perm = ${compact(permutation(length))}`)).toBe(
        `perm = ${REDACTED_SECRET}`,
      );
    }
  });

  it("does not let whitespace or a trailing comma dodge the 32/64 rule", () => {
    const values = syntheticBytes(64);
    const forms = [
      `[ ${values.join(" ,\n\t")} ]`,
      `[${values.join(",")},]`,
      `[\r\n${values.join(",\r\n")}\r\n]`,
    ];
    for (const form of forms) {
      const redacted = redactSecrets(`out: ${form}`);
      expect(redacted).toBe(`out: ${REDACTED_SECRET}`);
    }
  });

  it("preserves negative, out-of-range and fractional controls at every length", () => {
    for (const length of [...AMBIGUOUS_LENGTHS, ...BENIGN_LENGTHS]) {
      const negative = compact(permutation(length).map((v) => -v - 1));
      const outOfRange = compact(permutation(length).map((v) => v + 256));
      const mixedOne = compact([...syntheticBytes(length - 1), 256]);
      const fractional = compact(permutation(length).map((v) => v + 0.5));
      for (const control of [negative, outOfRange, mixedOne, fractional]) {
        const input = `values ${control}`;
        expect(redactSecrets(input)).toBe(input);
      }
    }
  });

  it("preserves short lists, nested lists and non-list brackets", () => {
    const benign = [
      "counts: [1, 2, 3, 4, 5]; ids: [1024, 65535, 300000]; ratio [1,2]",
      "matrix [[1,2],[3,4]] and index T[:100] and empty [] and text [abc]",
      `mixed [${syntheticBytes(63).join(",")}, "x"]`,
      `open ${compact(syntheticBytes(64)).slice(0, -1)}`,
    ];
    for (const input of benign) expect(redactSecrets(input)).toBe(input);
  });

  it("treats numeric JSON arrays as structural provenance and preserves them", () => {
    for (const length of [...AMBIGUOUS_LENGTHS, ...BENIGN_LENGTHS]) {
      const values = syntheticBytes(length);
      expect(redactSecretsInValue({ values })).toEqual({ values });
      // The same numbers inside a string follow the text policy.
      const text = compact(values);
      const asText = redactSecretsInValue({ stdout: text }).stdout;
      expect(asText).toBe(
        AMBIGUOUS_LENGTHS.includes(length as (typeof AMBIGUOUS_LENGTHS)[number])
          ? REDACTED_SECRET
          : text,
      );
    }
  });

  it("leaf-redacts numeric arrays under sensitive keys (nested sensitive fields)", () => {
    const artifact = {
      wallet: { secretKey: syntheticBytes(64), publicKey: syntheticBytes(32) },
      analysis: { permutation: permutation(80) },
    };
    expect(redactSecretsInValue(artifact)).toEqual({
      wallet: { secretKey: REDACTED_SECRET, publicKey: syntheticBytes(32) },
      analysis: { permutation: permutation(80) },
    });
  });

  it("redacts an integer list of any length or value range under a sensitive text label", () => {
    const labelled: ReadonlyArray<readonly [prefix: string, list: string]> = [
      ['"secretKey": ', compact(syntheticBytes(80))],
      ["private_key = ", spaced(syntheticBytes(33))],
      ["SEED_PHRASE=", compact([1, 2, 3])],
      ["'signing-key' : ", multiline(syntheticBytes(200))],
      ["secret: ", compact(permutation(64).map((v) => -v))],
      ["api_key:", compact([1000, 2000, 3000, 4000])],
      ["export AGENC_WALLET_VAULT_PASSPHRASE=", compact(syntheticBytes(16))],
    ];
    for (const [prefix, list] of labelled) {
      expect(redactSecrets(`${prefix}${list} tail`)).toBe(
        `${prefix}${REDACTED_SECRET} tail`,
      );
    }
  });

  it("does not treat ordinary labels or distant sensitive words as key-file context", () => {
    const benign = [
      `counts = ${compact(syntheticBytes(80))}`,
      `token_ids = ${compact(syntheticBytes(100))}`,
      `the secret is elsewhere; here: ${compact(syntheticBytes(80))}`,
      `password_length_histogram: ${compact(syntheticBytes(33))}`,
    ];
    // `token_ids` and `password_length_histogram` are not sensitive key names
    // (they do not normalize to a sensitive suffix), so they stay analytical.
    for (const input of benign) expect(redactSecrets(input)).toBe(input);
  });

  it("redacts multiline key-file output (cat ~/.config/solana/id.json)", () => {
    const stdout = `$ cat ~/.config/solana/id.json\n${multiline(syntheticBytes(64))}\n$ echo done\ndone`;
    const redacted = redactSecrets(stdout);
    expect(redacted).toBe(
      `$ cat ~/.config/solana/id.json\n${REDACTED_SECRET}\n$ echo done\ndone`,
    );
  });

  it("is idempotent and leaves neighbouring lists independent", () => {
    const input = [
      `a = ${compact(syntheticBytes(64))}`,
      `b = ${compact(permutation(80))}`,
      `c = ${compact(syntheticBytes(32))}`,
      `d = ${compact(permutation(31))}`,
    ].join("\n");
    const once = redactSecrets(input);
    expect(once).toBe(
      [
        `a = ${REDACTED_SECRET}`,
        `b = ${compact(permutation(80))}`,
        `c = ${REDACTED_SECRET}`,
        `d = ${compact(permutation(31))}`,
      ].join("\n"),
    );
    expect(redactSecrets(once)).toBe(once);
  });

  it("keeps the other sanitizer families working next to a preserved list", () => {
    const token = `xai-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"}`;
    const base58 = "3".repeat(88);
    const input = `perm ${compact(permutation(80))} key ${token} wallet ${base58} end`;
    expect(redactSecrets(input)).toBe(
      `perm ${compact(permutation(80))} key ${REDACTED_SECRET} wallet ${REDACTED_SECRET} end`,
    );
  });
});
