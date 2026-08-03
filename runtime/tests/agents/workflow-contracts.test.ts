import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cloneFiniteJsonValue,
  FiniteJsonValidationError,
  parseFiniteJsonBytes,
  type FiniteJsonLimits,
} from "../../src/agents/workflow-finite-json.js";
import {
  loadNamedWorkflowManifest,
  MAX_WORKFLOW_NAME_CODEPOINTS,
  validateWorkflowName,
  WorkflowManifestPathError,
} from "../../src/agents/workflow-manifest.js";
import {
  MAX_WORKFLOW_STEPS,
  validateWorkflowManifestValue,
  WorkflowManifestValidationError,
} from "../../src/agents/workflow-manifest-schema.js";
import {
  assertLegacyCommandInvocation,
  resolveEffectiveWorkflowLimits,
  validateWorkflowInvocationToolArgs,
  validateWorkflowInvocationValue,
  WorkflowInvocationValidationError,
} from "../../src/agents/workflow-invocation.js";

const roots: string[] = [];
const FINITE_LIMITS: FiniteJsonLimits = Object.freeze({
  maximumBytes: 64,
  maximumDepth: 3,
  maximumNodes: 8,
  maximumKeyUtf8Bytes: 4,
  maximumStringUtf8Bytes: 4,
  maximumTotalStringUtf8Bytes: 8,
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function expectFiniteCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected finite JSON validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(FiniteJsonValidationError);
    expect((error as FiniteJsonValidationError).code).toBe(code);
  }
}

describe("finite workflow JSON", () => {
  it("accepts exact byte/string/key/node/depth limits and returns an inert tree", () => {
    const value = parseFiniteJsonBytes(
      Buffer.from('{"key":["1234",true]}'),
      "fixture",
      {
        maximumBytes: 21,
        maximumDepth: 2,
        maximumNodes: 4,
        maximumKeyUtf8Bytes: 3,
        maximumStringUtf8Bytes: 4,
        maximumTotalStringUtf8Bytes: 7,
      },
    ) as Readonly<Record<string, unknown>>;

    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.key)).toBe(true);
  });

  it.each([
    ["duplicate keys", '{"a":1,"a":2}', "JSON_DUPLICATE_KEY"],
    ["comments", '{"a":/* no */1}', "JSON_SYNTAX"],
    ["trailing comma", '{"a":1,}', "JSON_SYNTAX"],
    ["negative zero", "-0", "JSON_NUMBER"],
  ])("rejects %s", (_name, source, code) => {
    expectFiniteCode(
      () => parseFiniteJsonBytes(Buffer.from(source), "fixture", FINITE_LIMITS),
      code,
    );
  });

  it("rejects BOM, invalid UTF-8, and each resource boundary at plus one", () => {
    expectFiniteCode(
      () =>
        parseFiniteJsonBytes(
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("null")]),
          "fixture",
          FINITE_LIMITS,
        ),
      "JSON_BOM",
    );
    expectFiniteCode(
      () => parseFiniteJsonBytes(Buffer.from([0xc3, 0x28]), "fixture", FINITE_LIMITS),
      "JSON_UTF8",
    );
    expectFiniteCode(
      () => parseFiniteJsonBytes(Buffer.from("12345"), "fixture", { ...FINITE_LIMITS, maximumBytes: 4 }),
      "JSON_BYTES",
    );
    expectFiniteCode(
      () => parseFiniteJsonBytes(Buffer.from('{"abcde":1}'), "fixture", FINITE_LIMITS),
      "JSON_KEY_BYTES",
    );
    expectFiniteCode(
      () => parseFiniteJsonBytes(Buffer.from('"abcde"'), "fixture", FINITE_LIMITS),
      "JSON_STRING_BYTES",
    );
    expectFiniteCode(
      () => parseFiniteJsonBytes(Buffer.from('["1234","1234","x"]'), "fixture", FINITE_LIMITS),
      "JSON_TOTAL_STRING_BYTES",
    );
    expectFiniteCode(
      () => parseFiniteJsonBytes(Buffer.from("[[[[]]]]"), "fixture", FINITE_LIMITS),
      "JSON_DEPTH",
    );
    expectFiniteCode(
      () => parseFiniteJsonBytes(Buffer.from("[0,1,2,3,4,5,6,7]"), "fixture", FINITE_LIMITS),
      "JSON_NODES",
    );
  });

  it("does not invoke accessors or Proxy traps for programmatic input", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expectFiniteCode(
      () => cloneFiniteJsonValue(accessor, "fixture", FINITE_LIMITS),
      "JSON_ACCESSOR",
    );
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const proxy = new Proxy({}, {
      ownKeys() {
        trapCalls += 1;
        return [];
      },
    });
    expectFiniteCode(
      () => cloneFiniteJsonValue(proxy, "fixture", FINITE_LIMITS),
      "JSON_PROXY",
    );
    expect(trapCalls).toBe(0);
  });
});

describe("workflow manifest schema and loader", () => {
  it("normalizes the one-epoch legacy DAG without mutating caller input", () => {
    const source = {
      steps: [
        { id: "producer", message: "produce", group: "workers" },
        { id: "consumer", message: "{{steps.producer}}", after: ["workers"] },
      ],
    };
    const document = validateWorkflowManifestValue(source);

    expect(document.kind).toBe("agent_dag");
    expect(document.sourceVersion).toBe(1);
    expect(document.diagnostics).toHaveLength(1);
    expect(Object.isFrozen(document.manifest)).toBe(true);
    expect(source).toEqual({
      steps: [
        { id: "producer", message: "produce", group: "workers" },
        { id: "consumer", message: "{{steps.producer}}", after: ["workers"] },
      ],
    });
  });

  it.each([
    [
      "duplicate ids",
      [
        { id: "a", message: "a" },
        { id: "a", message: "b" },
      ],
    ],
    ["unknown refs", [{ id: "a", message: "a", after: [{ step: "missing" }] }]],
    ["self refs", [{ id: "a", message: "a", after: [{ step: "a" }] }]],
    [
      "cycles",
      [
        { id: "a", message: "a", after: [{ step: "b" }] },
        { id: "b", message: "b", inputs: { source: { step: "a" } } },
      ],
    ],
  ])("rejects %s before dispatch", (_name, steps) => {
    expect(() =>
      validateWorkflowManifestValue({
        format_version: 2,
        kind: "agent_dag",
        steps,
      }),
    ).toThrow(WorkflowManifestValidationError);
  });

  it("accepts exactly 1,024 steps and rejects 1,025", () => {
    const steps = Array.from({ length: MAX_WORKFLOW_STEPS }, (_, index) => ({
      id: `step-${index}`,
      message: "bounded",
    }));
    expect(
      validateWorkflowManifestValue({ format_version: 2, kind: "agent_dag", steps }),
    ).toMatchObject({ kind: "agent_dag" });
    expect(() =>
      validateWorkflowManifestValue({
        format_version: 2,
        kind: "agent_dag",
        steps: [...steps, { id: "plus-one", message: "rejected" }],
      }),
    ).toThrow(WorkflowManifestValidationError);
  });

  it("rejects traversal, normalization ambiguity, and component plus one", () => {
    for (const name of [
      "../escape",
      "..\\escape",
      ".",
      "e\u0301",
      "bad\u0000name",
      "stream:name",
      "bad<name",
      "bad>name",
      'bad"name',
      "bad|name",
      "bad?name",
      "bad*name",
      "trailing.",
      "trailing ",
      "CON",
      "con.txt",
      "PrN.workflow",
      "AUX",
      "nul.json",
      "COM1",
      "com9.log",
      "LPT1",
      "lpt9.txt",
    ]) {
      expect(() => validateWorkflowName(name)).toThrow(WorkflowManifestPathError);
    }
    for (const name of ["console", "com0", "lpt0"]) {
      expect(() => validateWorkflowName(name)).not.toThrow();
    }
    expect(() => validateWorkflowName("a".repeat(MAX_WORKFLOW_NAME_CODEPOINTS))).not.toThrow();
    expect(() => validateWorkflowName("a".repeat(MAX_WORKFLOW_NAME_CODEPOINTS + 1))).toThrow(
      WorkflowManifestPathError,
    );
  });

  it("loads only a regular file beneath the first trusted root", async () => {
    const root = await temporaryRoot("agenc-workflow-loader-");
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "safe.json"), '{"command":"first"}', { mode: 0o600 });
    await writeFile(join(second, "safe.json"), '{"command":"second"}', { mode: 0o600 });

    const loaded = await loadNamedWorkflowManifest({ name: "safe", roots: [first, second] });
    expect(loaded.sourceRoot).toBe(first);
    expect(loaded.document).toMatchObject({
      kind: "legacy_command",
      manifest: { command: "first" },
    });
  });

  it("rejects a symlink manifest and detects candidate replacement races", async () => {
    const root = await temporaryRoot("agenc-workflow-race-");
    const workflows = join(root, "workflows");
    await mkdir(workflows);
    await writeFile(join(root, "outside.json"), '{"command":"outside"}', { mode: 0o600 });
    await symlink(join(root, "outside.json"), join(workflows, "linked.json"));
    await expect(loadNamedWorkflowManifest({ name: "linked", roots: [workflows] })).rejects.toMatchObject({
      code: "WORKFLOW_MANIFEST_UNSAFE",
    });

    const candidate = join(workflows, "raced.json");
    await writeFile(candidate, '{"command":"before"}', { mode: 0o600 });
    await expect(
      loadNamedWorkflowManifest({
        name: "raced",
        roots: [workflows],
        hooks: {
          async afterCandidateOpen() {
            await rename(candidate, `${candidate}.old`);
            await writeFile(candidate, '{"command":"after"}', { mode: 0o600 });
          },
        },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_MANIFEST_RACE" });
  });
});

describe("WorkflowTool invocation contract", () => {
  it("is strict and invocation overrides only tighten manifest ceilings", () => {
    const invocation = validateWorkflowInvocationValue({
      name: "review",
      args: { max_concurrency: 8, max_handoff_tokens: 4_096 },
    });
    const manifest = validateWorkflowManifestValue({
      format_version: 2,
      kind: "agent_dag",
      max_concurrency: 12,
      max_handoff_tokens: 8_192,
      steps: [{ id: "a", message: "a" }],
    });
    if (manifest.kind !== "agent_dag") throw new Error("expected DAG");
    expect(resolveEffectiveWorkflowLimits(manifest.manifest, invocation, 6, 3_000)).toEqual({
      formatVersion: 2,
      maxConcurrency: 6,
      maxHandoffTokens: 3_000,
      failurePolicy: "continue_independent",
    });
    expect(() => validateWorkflowInvocationValue({ name: "review", args: { extra: true } })).toThrow(
      WorkflowInvocationValidationError,
    );
  });

  it("ignores runtime metadata without evaluating invocation accessors", () => {
    const executionArgs: Record<string | symbol, unknown> = { name: "safe" };
    executionArgs[Symbol("runtime broker")] = Object.freeze({ internal: true });
    expect(validateWorkflowInvocationToolArgs(executionArgs)).toEqual({ name: "safe" });

    let calls = 0;
    Object.defineProperty(executionArgs, "args", {
      enumerable: true,
      get() {
        calls += 1;
        return {};
      },
    });
    expect(() => validateWorkflowInvocationToolArgs(executionArgs)).toThrow(
      WorkflowInvocationValidationError,
    );
    expect(calls).toBe(0);
  });

  it("keeps legacy command invocations override-free", () => {
    expect(() => assertLegacyCommandInvocation({ name: "legacy", args: {} })).not.toThrow();
    expect(() =>
      assertLegacyCommandInvocation({ name: "legacy", args: { max_concurrency: 1 } }),
    ).toThrow(WorkflowInvocationValidationError);
  });
});
