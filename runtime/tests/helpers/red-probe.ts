import { isDeepStrictEqual as nodeIsDeepStrictEqual } from "node:util";

export const RED_PROBE_PROTOCOL_VERSION = 1 as const;
export const RED_PROBE_EXPECTED_EXIT_CODE = 86 as const;
export const RED_PROBE_PROTOCOL_PREFIX = "AGENC_RED_PROBE_V1 " as const;

const FINGERPRINT_PATTERN = /^[A-Z0-9][A-Z0-9._:/-]{0,127}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAXIMUM_ID_CHARACTERS = 64;
const freeze = Object.freeze;
const isDeepStrictEqual = nodeIsDeepStrictEqual;
export const RED_PROBE_TASK_IDS = Object.freeze([
  "FND-001",
  "A1",
  "A2a",
  "A2b",
  "A3",
  "A4",
  "B1",
  "B2",
  "B3a",
  "B3b",
  "C1",
  "C2",
  "C3a",
  "C3b",
  "D1",
  "D2",
  "D3",
  "E1a",
  "E1b",
  "E2",
  "E3",
] as const);
const RED_PROBE_TASK_ID_SET: ReadonlySet<string> = new Set(RED_PROBE_TASK_IDS);

export interface RedProbeIdentity {
  readonly id: string;
  readonly task: string;
  readonly fingerprint: string;
}

export interface RedProbeEvidence {
  readonly protocolVersion: typeof RED_PROBE_PROTOCOL_VERSION;
  readonly outcome: "expected-red";
  readonly id: string;
  readonly task: string;
  readonly fingerprint: string;
  readonly authenticationTag: string;
  readonly assertions: 1;
  readonly skipped: 0;
  readonly todos: 0;
}

export type RedProbeAssertion = (
  identity: RedProbeIdentity,
  actual: unknown,
  expected: unknown,
) => void;

type ExpectedFailureReporter = (identity: RedProbeIdentity) => void;

function validateIdentity(identity: RedProbeIdentity): void {
  if (
    identity.id.length > MAXIMUM_ID_CHARACTERS ||
    !ID_PATTERN.test(identity.id)
  ) {
    throw new TypeError("red-probe id is not canonical");
  }
  if (!RED_PROBE_TASK_ID_SET.has(identity.task)) {
    throw new TypeError("red-probe task is not canonical");
  }
  if (!FINGERPRINT_PATTERN.test(identity.fingerprint)) {
    throw new TypeError("red-probe fingerprint is not canonical");
  }
}

/**
 * Create one assertion capability for the bootstrap-owned root invocation.
 *
 * The reporter is retained only in this closure. Imported dependencies may
 * load this factory, but they cannot obtain the bootstrap's reporter or its
 * assertion instance. Getters, proxies, and every other exception escape
 * normally so unrelated crashes cannot be mistaken for a reproduced defect.
 */
export function createRedProbeAssertion(
  reportToBootstrap: ExpectedFailureReporter,
): RedProbeAssertion {
  if (typeof reportToBootstrap !== "function") {
    throw new TypeError("red-probe reporter must be a function");
  }
  let assertionAttempted = false;
  return freeze(function expectDeepStrictEqualRedProbe(
    identity: RedProbeIdentity,
    actual: unknown,
    expected: unknown,
  ): void {
    if (assertionAttempted) {
      throw new Error("red-probe assertion may only be attempted once");
    }
    assertionAttempted = true;
    validateIdentity(identity);
    if (!isDeepStrictEqual(actual, expected)) {
      reportToBootstrap(
        freeze({
          fingerprint: identity.fingerprint,
          id: identity.id,
          task: identity.task,
        }),
      );
    }
  });
}
