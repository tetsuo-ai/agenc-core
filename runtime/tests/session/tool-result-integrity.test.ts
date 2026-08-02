import { describe, expect, it } from "vitest";
import {
  MAX_CANONICAL_BODY_DEPTH,
  MAX_CANONICAL_BODY_NODES,
  ToolResultCanonicalizationError,
  createToolResultIntegrity,
  deterministicToolResultId,
  digestToolResultBody,
  verifyToolResultIntegrity,
  withPersistedToolResultRepresentation,
} from "../../src/session/tool-result-integrity.js";

describe("tool-result integrity", () => {
  it("binds equal-length body substitutions to different canonical digests", () => {
    const alpha = digestToolResultBody("alpha");
    const omega = digestToolResultBody("omega");

    expect(alpha.byteLength).toBe(5);
    expect(omega.byteLength).toBe(5);
    expect(alpha.digest).not.toBe(omega.digest);
  });

  it("canonicalizes structured JSON independently of object insertion order", () => {
    const left = Object.freeze({
      type: "tool_result",
      nested: Object.freeze({ b: 2, a: 1 }),
    });
    const right = {
      nested: { a: 1, b: 2 },
      type: "tool_result",
    };

    expect(digestToolResultBody(left)).toEqual(digestToolResultBody(right));
    expect(left.nested).toEqual({ b: 2, a: 1 });
  });

  it("rejects ill-formed UTF-16 instead of aliasing it to the replacement character", () => {
    const replacementCharacter = "\ufffd";
    const malformedStrings = ["\ud800", "\udc00"];

    expect(digestToolResultBody(replacementCharacter)).toMatchObject({
      byteLength: 3,
    });
    expect(
      deterministicToolResultId("run-unicode", replacementCharacter),
    ).toMatch(/^tool-result:[0-9a-f]{64}$/);

    for (const malformed of malformedStrings) {
      expect(() => digestToolResultBody(malformed)).toThrowError(
        expect.objectContaining<ToolResultCanonicalizationError>({
          kind: "integrity_failure",
          code: "unsupported_body_value",
        }),
      );
      expect(() => digestToolResultBody({ [malformed]: "value" })).toThrowError(
        expect.objectContaining<ToolResultCanonicalizationError>({
          code: "unsupported_body_value",
        }),
      );
      expect(() =>
        deterministicToolResultId("run-unicode", malformed),
      ).toThrowError(
        expect.objectContaining<ToolResultCanonicalizationError>({
          code: "unsupported_body_value",
        }),
      );
    }

    const replacementIntegrity = createToolResultIntegrity({
      runId: "run-unicode",
      toolCallId: replacementCharacter,
      content: "body",
    });
    for (const malformed of malformedStrings) {
      expect(
        verifyToolResultIntegrity({
          integrity: {
            ...replacementIntegrity,
            toolCallId: malformed,
          },
          expectedRunId: "run-unicode",
          toolCallId: malformed,
          content: "body",
        }),
      ).toMatchObject({
        status: "invalid",
        failure: { code: "invalid_integrity_metadata" },
      });
    }
  });

  it("rejects non-finite values instead of aliasing their persisted identity to null", () => {
    const nullIntegrity = createToolResultIntegrity({
      runId: "run-number",
      toolCallId: "call-number",
      content: null,
    });

    for (const nonFinite of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => digestToolResultBody(nonFinite)).toThrowError(
        expect.objectContaining<ToolResultCanonicalizationError>({
          kind: "integrity_failure",
          code: "unsupported_body_value",
        }),
      );
      expect(
        verifyToolResultIntegrity({
          integrity: nullIntegrity,
          expectedRunId: "run-number",
          toolCallId: "call-number",
          content: nonFinite,
        }),
      ).toMatchObject({
        status: "invalid",
        failure: { code: "unsupported_body_value" },
      });
    }
  });

  it("preflights object width against the remaining canonical node budget", () => {
    expect(digestToolResultBody({ a: 1, b: 2 }, { maxNodes: 3 })).toEqual(
      digestToolResultBody({ b: 2, a: 1 }, { maxNodes: 3 }),
    );
    expect(() =>
      digestToolResultBody({ a: 1, b: 2, c: 3 }, { maxNodes: 3 }),
    ).toThrowError(
      expect.objectContaining<ToolResultCanonicalizationError>({
        kind: "operational_deferral",
        code: "canonical_body_node_limit",
      }),
    );
    expect(() =>
      digestToolResultBody({}, { maxNodes: MAX_CANONICAL_BODY_NODES + 1 }),
    ).toThrowError(/maxNodes/);
  });

  it("derives result identity from the complete run and call identities", () => {
    const sharedPrefix = "call-".repeat(700);
    const left = deterministicToolResultId("run-a", `${sharedPrefix}a`);
    const right = deterministicToolResultId("run-a", `${sharedPrefix}b`);

    expect(left).not.toBe(right);
    expect(left).toBe(deterministicToolResultId("run-a", `${sharedPrefix}a`));
    expect(left).not.toBe(
      deterministicToolResultId("run-b", `${sharedPrefix}a`),
    );
  });

  it("rejects persisted body substitution without exposing the body", () => {
    const integrity = createToolResultIntegrity({
      runId: "run-1",
      toolCallId: "call-1",
      content: "alpha-secret-body",
    });
    const verified = verifyToolResultIntegrity({
      integrity,
      toolCallId: "call-1",
      content: "omega-secret-body",
    });

    expect(verified).toMatchObject({
      status: "invalid",
      failure: { code: "persisted_body_digest_mismatch" },
    });
    expect(JSON.stringify(verified)).not.toContain("alpha-secret-body");
    expect(JSON.stringify(verified)).not.toContain("omega-secret-body");
  });

  it("rejects substituted run, call, and result identities", () => {
    const integrity = createToolResultIntegrity({
      runId: "run-1",
      toolCallId: "call-1",
      content: "alpha",
    });

    expect(
      verifyToolResultIntegrity({
        integrity,
        expectedRunId: "run-2",
        toolCallId: "call-1",
        content: "alpha",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "run_id_mismatch" },
    });
    expect(
      verifyToolResultIntegrity({
        integrity,
        expectedRunId: "run-1",
        toolCallId: "call-2",
        content: "alpha",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "tool_call_id_mismatch" },
    });
    expect(
      verifyToolResultIntegrity({
        integrity: {
          ...integrity,
          resultId: `tool-result:${"0".repeat(64)}`,
        },
        expectedRunId: "run-1",
        toolCallId: "call-1",
        content: "alpha",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "result_id_mismatch" },
    });
  });

  it.each([
    ["bit flip", "alphb"],
    ["truncation", "alph"],
    ["array reorder", ["omega", "alpha"]],
  ])("detects %s corruption of a persisted body", (_label, corrupted) => {
    const content = Array.isArray(corrupted) ? ["alpha", "omega"] : "alpha";
    const integrity = createToolResultIntegrity({
      runId: "run-corruption",
      toolCallId: "call-corruption",
      content,
    });

    expect(
      verifyToolResultIntegrity({
        integrity,
        toolCallId: "call-corruption",
        content: corrupted,
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "persisted_body_digest_mismatch" },
    });
  });

  it("keeps original identity immutable across a compacted representation", () => {
    const original = createToolResultIntegrity({
      runId: "run-1",
      toolCallId: "call-1",
      content: "the complete original result",
    });
    const compacted = withPersistedToolResultRepresentation(
      original,
      "compacted",
      "[compacted tool result]",
    );

    expect(compacted.original).toEqual(original.original);
    expect(compacted.persisted).not.toEqual(original.persisted);
    expect(
      verifyToolResultIntegrity({
        integrity: compacted,
        toolCallId: "call-1",
        content: "[compacted tool result]",
      }),
    ).toMatchObject({ status: "valid" });
  });

  it("rejects metadata whose original representation launders its identity", () => {
    const integrity = createToolResultIntegrity({
      runId: "run-1",
      toolCallId: "call-1",
      content: "alpha",
    });
    const laundered = {
      ...integrity,
      original: digestToolResultBody("omega"),
    };

    expect(
      verifyToolResultIntegrity({
        integrity: laundered,
        toolCallId: "call-1",
        content: "alpha",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "original_representation_mismatch" },
    });
  });

  it("rejects unversioned extension fields instead of hashing an ambiguous shape", () => {
    const integrity = createToolResultIntegrity({
      runId: "run-1",
      toolCallId: "call-1",
      content: "alpha",
    });
    expect(
      verifyToolResultIntegrity({
        integrity: { ...integrity, unversionedField: true },
        toolCallId: "call-1",
        content: "alpha",
      }),
    ).toMatchObject({
      status: "invalid",
      failure: { code: "invalid_integrity_metadata" },
    });
  });

  it("defers canonicalization beyond the explicit depth bound", () => {
    let value: unknown = "leaf";
    for (let depth = 0; depth <= MAX_CANONICAL_BODY_DEPTH; depth += 1) {
      value = [value];
    }

    expect(() => digestToolResultBody(value)).toThrowError(
      expect.objectContaining<ToolResultCanonicalizationError>({
        kind: "operational_deferral",
        code: "canonical_body_depth_limit",
      }),
    );
  });
});
