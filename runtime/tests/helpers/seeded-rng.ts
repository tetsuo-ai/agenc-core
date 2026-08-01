import { createHash } from "node:crypto";

export const SEEDED_RNG_ALGORITHM =
  "sha256-domain-xorshift32-rejection-v1" as const;
export const MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES = 1_024;
export const MAX_SEEDED_RNG_SEED_BYTES = 1_048_576;
export const MAX_SEQUENCE_RNG_VALUES = 100_000;
export const MAX_SEQUENCE_RNG_LABEL_UTF8_BYTES = 1_024;
export const MAX_RNG_REJECTION_DRAWS = 128;

const RNG_DOMAIN_SEPARATOR = "agenc.test.seeded-rng.v1\0";
const UINT32_BYTE_LENGTH = 4;
const UINT32_RANGE = 0x1_0000_0000;
const NONZERO_STATE_FALLBACK = 0x9e37_79b9;

export type SeededRngErrorCode =
  | "domain_empty"
  | "domain_limit"
  | "invalid_integer_bound"
  | "invalid_sequence_value"
  | "malformed_unicode"
  | "rejection_limit"
  | "seed_limit"
  | "sequence_empty"
  | "sequence_exhausted"
  | "sequence_label_limit"
  | "sequence_limit"
  | "sequence_mutated"
  | "sequence_remaining"
  | "sequence_sparse";

export class SeededRngError extends Error {
  readonly code: SeededRngErrorCode;

  constructor(code: SeededRngErrorCode, message: string) {
    super(message);
    this.name = "SeededRngError";
    this.code = code;
  }
}

export interface SeededRngOptions {
  readonly domain: string;
  readonly seed: string | Uint8Array;
}

export interface SeededRng {
  readonly algorithm: typeof SEEDED_RNG_ALGORITHM;
  nextUint32(): number;
  nextFloat(): number;
  nextInt(maxExclusive: number): number;
}

export interface SequenceRng {
  nextFloat(): number;
  remaining(): number;
  assertConsumed(): void;
}

type BoundedStringKind = "domain" | "seed" | "sequence_label";

const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const typedArrayLengthGetter = (() => {
  const getter = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    "length",
  )?.get;
  if (getter === undefined) {
    throw new Error("typed-array length intrinsic is unavailable");
  }
  return getter as (this: Uint8Array) => number;
})();

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        throw new SeededRngError(
          "malformed_unicode",
          `${label} contains an unpaired high surrogate at UTF-16 offset ${index}`,
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new SeededRngError(
        "malformed_unicode",
        `${label} contains an unpaired low surrogate at UTF-16 offset ${index}`,
      );
    }
  }
}

function byteLimitError(kind: BoundedStringKind): SeededRngError {
  if (kind === "domain") {
    return new SeededRngError(
      "domain_limit",
      `RNG domain exceeds ${MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  if (kind === "seed") {
    return new SeededRngError(
      "seed_limit",
      `seed exceeds ${MAX_SEEDED_RNG_SEED_BYTES} bytes`,
    );
  }
  return new SeededRngError(
    "sequence_label_limit",
    `sequence label exceeds ${MAX_SEQUENCE_RNG_LABEL_UTF8_BYTES} UTF-8 bytes`,
  );
}

function encodeBoundedString(
  value: string,
  label: string,
  maximumUtf8Bytes: number,
  kind: BoundedStringKind,
): Uint8Array {
  // Every well-formed UTF-16 code unit contributes at least one UTF-8 byte.
  // Rejecting on this lower bound first keeps both validation and encoding
  // work bounded without rejecting any string that could fit the byte cap.
  if (value.length > maximumUtf8Bytes) throw byteLimitError(kind);
  assertWellFormedUnicode(value, label);
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > maximumUtf8Bytes) throw byteLimitError(kind);
  return bytes;
}

function uint32BigEndian(value: number): Uint8Array {
  const bytes = new Uint8Array(UINT32_BYTE_LENGTH);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function copySeed(seed: string | Uint8Array): Uint8Array {
  if (typeof seed === "string") {
    return encodeBoundedString(
      seed,
      "seed",
      MAX_SEEDED_RNG_SEED_BYTES,
      "seed",
    );
  }
  const seedLength = typedArrayLengthGetter.call(seed) as number;
  if (seedLength > MAX_SEEDED_RNG_SEED_BYTES) {
    throw byteLimitError("seed");
  }
  const copy = new Uint8Array(seedLength);
  Uint8Array.prototype.set.call(copy, seed);
  return copy;
}

function copySequenceValues(values: readonly number[]): number[] {
  if (!Array.isArray(values)) {
    throw new SeededRngError(
      "invalid_sequence_value",
      "sequence RNG values must be an array",
    );
  }
  const initialLength = values.length;
  if (initialLength === 0) {
    throw new SeededRngError(
      "sequence_empty",
      "sequence RNG requires at least one value",
    );
  }
  if (initialLength > MAX_SEQUENCE_RNG_VALUES) {
    throw new SeededRngError(
      "sequence_limit",
      `sequence RNG exceeds ${MAX_SEQUENCE_RNG_VALUES} values`,
    );
  }

  const sequence = new Array<number>(initialLength);
  for (let index = 0; index < initialLength; index += 1) {
    if (values.length !== initialLength) {
      throw new SeededRngError(
        "sequence_mutated",
        "sequence RNG input length changed while it was copied",
      );
    }
    if (!Object.prototype.hasOwnProperty.call(values, index)) {
      throw new SeededRngError(
        "sequence_sparse",
        `sequence RNG input is sparse at index ${index}`,
      );
    }
    const value = values[index];
    if (values.length !== initialLength) {
      throw new SeededRngError(
        "sequence_mutated",
        "sequence RNG input length changed while it was copied",
      );
    }
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new SeededRngError(
        "invalid_sequence_value",
        `sequence RNG value ${index} must be finite and in [0, 1)`,
      );
    }
    sequence[index] = value;
  }
  if (values.length !== initialLength) {
    throw new SeededRngError(
      "sequence_mutated",
      "sequence RNG input length changed while it was copied",
    );
  }
  return sequence;
}

function deriveInitialState(domainBytes: Uint8Array, seed: Uint8Array): number {
  const digest = createHash("sha256")
    .update(RNG_DOMAIN_SEPARATOR, "ascii")
    .update(uint32BigEndian(domainBytes.byteLength))
    .update(domainBytes)
    .update(uint32BigEndian(seed.byteLength))
    .update(seed)
    .digest();
  const state = digest.readUInt32BE(0);
  return state === 0 ? NONZERO_STATE_FALLBACK : state;
}

/**
 * Create a reproducible non-cryptographic test stream.
 *
 * The SHA-256 derivation isolates named test domains. Xorshift32 then provides
 * a portable bit-exact stream; callers must not use it for secrets or runtime
 * identifiers.
 */
export function createSeededRng(options: SeededRngOptions): SeededRng {
  const domainBytes = encodeBoundedString(
    options.domain,
    "domain",
    MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES,
    "domain",
  );
  if (domainBytes.byteLength === 0) {
    throw new SeededRngError("domain_empty", "RNG domain must not be empty");
  }
  const seed = copySeed(options.seed);
  let state = deriveInitialState(domainBytes, seed);

  const nextUint32 = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };

  const rng: SeededRng = {
    algorithm: SEEDED_RNG_ALGORITHM,
    nextUint32,
    nextFloat: () => nextUint32() / UINT32_RANGE,
    nextInt(maxExclusive: number): number {
      if (
        !Number.isSafeInteger(maxExclusive) ||
        maxExclusive < 1 ||
        maxExclusive > UINT32_RANGE
      ) {
        throw new SeededRngError(
          "invalid_integer_bound",
          `maxExclusive must be a safe integer in [1, ${UINT32_RANGE}]`,
        );
      }
      const acceptanceLimit =
        UINT32_RANGE - (UINT32_RANGE % maxExclusive);
      for (
        let drawIndex = 0;
        drawIndex < MAX_RNG_REJECTION_DRAWS;
        drawIndex += 1
      ) {
        const value = nextUint32();
        if (value < acceptanceLimit) return value % maxExclusive;
      }
      throw new SeededRngError(
        "rejection_limit",
        `integer sampling exceeded ${MAX_RNG_REJECTION_DRAWS} rejection draws`,
      );
    },
  };

  return Object.freeze(rng);
}

/** Create a finite, exact `[0, 1)` stream for boundary-oriented tests. */
export function createSequenceRng(
  values: readonly number[],
  label = "sequence RNG",
): SequenceRng {
  encodeBoundedString(
    label,
    "sequence label",
    MAX_SEQUENCE_RNG_LABEL_UTF8_BYTES,
    "sequence_label",
  );
  const sequence = copySequenceValues(values);
  let offset = 0;

  return Object.freeze({
    nextFloat(): number {
      const value = sequence[offset];
      if (value === undefined) {
        throw new SeededRngError(
          "sequence_exhausted",
          `${label} exhausted after ${sequence.length} values`,
        );
      }
      offset += 1;
      return value;
    },
    remaining: () => sequence.length - offset,
    assertConsumed(): void {
      const remaining = sequence.length - offset;
      if (remaining === 0) return;
      throw new SeededRngError(
        "sequence_remaining",
        `${label} has ${remaining} unconsumed value(s)`,
      );
    },
  });
}
