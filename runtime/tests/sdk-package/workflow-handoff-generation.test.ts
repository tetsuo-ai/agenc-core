import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { synchronizeWorkflowHandoffGenerated } from "../../scripts/check-sdk-generated-types.mjs";
import { renderWorkflowHandoffGenerated } from "../../scripts/sdk-workflow-handoff.mjs";

interface SchemaNode {
  type?: string;
  const?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  [key: string]: unknown;
}

interface HandoffSchema extends SchemaNode {
  properties: Record<string, SchemaNode>;
  required: string[];
  "x-agenc-post-validation": Record<string, number | boolean>;
}

const roots: string[] = [];
const repositoryRoot = join(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);
const schemaFile = join(repositoryRoot, "runtime/src/agents/workflow-handoff-artifact.v1.schema.json");
const runtimeFile = join(repositoryRoot, "runtime/src/agents/workflow-handoff-schema.ts");
const publicFile = join(repositoryRoot, "packages/agenc-sdk/src/workflow-handoff.generated.ts");
const validationFile = join(repositoryRoot, "packages/agenc-sdk/src/workflow-handoff-validation.ts");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixtureRuntimeSource(schema: HandoffSchema): string {
  const properties = schema.properties;
  const post = schema["x-agenc-post-validation"];
  const constants = {
    WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION: properties.format_version.const,
    WORKFLOW_HANDOFF_ARTIFACT_KIND: properties.kind.const,
    WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH: properties.compatibility_epoch.const,
    MAX_WORKFLOW_ARTIFACT_BYTES: properties.byte_length.maximum,
    MAX_WORKFLOW_STEP_RESULT_TOKENS: properties.token_count.maximum,
    MAX_WORKFLOW_STEP_PREVIEW_BYTES: post.previewMaxUtf8Bytes,
    MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES: post.ownerFieldMaxUtf8Bytes,
    WORKFLOW_HANDOFF_ARTIFACT_SCHEMA: schema,
  };
  return Object.entries(constants).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join("\n");
}

function validArtifact() {
  const artifactId = `wh_${"0".repeat(48)}`;
  return {
    format_version: 1,
    kind: "workflow_handoff",
    compatibility_epoch: "workflow_handoff.v1/state-schema.22",
    artifact_id: artifactId,
    owner: { run_id: "run", workflow_id: "workflow", producer_step_id: "step" },
    digest: `sha256:${"0".repeat(64)}`,
    byte_length: 4,
    token_count: 1,
    media_type: "text/plain",
    encoding: "utf-8",
    storage_ref: `workflow-handoff:${artifactId}`,
    created_at_ms: 1,
    committed_at_ms: 2,
    commit_sequence: 1,
    preview: "data",
    preview_truncated: false,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "agenc-handoff-generation-"));
  roots.push(root);
  const schema = JSON.parse(await readFile(schemaFile, "utf8")) as HandoffSchema;
  const options = {
    schemaPath: join(root, "schema.json"),
    runtimeSourcePath: join(root, "runtime.ts"),
    generatedPath: join(root, "workflow-handoff.generated.ts"),
  };
  await writeFile(options.schemaPath, JSON.stringify(schema));
  await writeFile(options.runtimeSourcePath, fixtureRuntimeSource(schema));
  await synchronizeWorkflowHandoffGenerated({ ...options, write: true });
  return { root, schema, options };
}

async function validateGenerated(root: string, candidate: unknown): Promise<{ valid: boolean; name?: string; code?: string }> {
  for (const [sourcePath, outputName] of [
    [join(root, "workflow-handoff.generated.ts"), "workflow-handoff.generated.js"],
    [validationFile, "workflow-handoff-validation.js"],
  ]) {
    const { outputText } = ts.transpileModule(await readFile(sourcePath, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    await writeFile(join(root, outputName), outputText);
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e",
    `import { validateWorkflowHandoffArtifact } from './workflow-handoff.generated.js';
try { validateWorkflowHandoffArtifact(JSON.parse(process.argv[1])); console.log(JSON.stringify({valid:true})); }
catch (error) { console.log(JSON.stringify({valid:false,name:error.name,code:error.code})); }`,
    JSON.stringify(candidate),
  ], { cwd: root, encoding: "utf8" });
  return JSON.parse(stdout);
}

const mutations: readonly {
  name: string;
  mutate(schema: HandoffSchema): void;
  accepted(): unknown;
  rejectsOriginal: boolean;
}[] = [
  {
    name: "required field",
    mutate(schema) { schema.properties.extra = { type: "boolean" }; schema.required.push("extra"); },
    accepted: () => ({ ...validArtifact(), extra: true }),
    rejectsOriginal: true,
  },
  {
    name: "optional marker",
    mutate(schema) { schema.required = schema.required.filter((name) => name !== "token_count"); },
    accepted: () => { const { token_count: _tokens, ...candidate } = validArtifact(); return candidate; },
    rejectsOriginal: false,
  },
  {
    name: "removed field",
    mutate(schema) { delete schema.properties.encoding; schema.required = schema.required.filter((name) => name !== "encoding"); },
    accepted: () => { const { encoding: _encoding, ...candidate } = validArtifact(); return candidate; },
    rejectsOriginal: true,
  },
  {
    name: "literal",
    mutate(schema) { schema.properties.kind.const = "workflow_handoff_next"; },
    accepted: () => ({ ...validArtifact(), kind: "workflow_handoff_next" }),
    rejectsOriginal: true,
  },
  {
    name: "numeric limit",
    mutate(schema) { schema.properties.token_count.maximum = 0; },
    accepted: () => ({ ...validArtifact(), token_count: 0 }),
    rejectsOriginal: true,
  },
  {
    name: "pattern",
    mutate(schema) { schema.properties.artifact_id.pattern = "^wh_[1-9a-f]{48}$"; },
    accepted: () => ({ ...validArtifact(), artifact_id: `wh_${"1".repeat(48)}`, storage_ref: `workflow-handoff:wh_${"1".repeat(48)}` }),
    rejectsOriginal: true,
  },
  {
    name: "property order",
    mutate(schema) { schema.properties = Object.fromEntries(Object.entries(schema.properties).reverse()); },
    accepted: validArtifact,
    rejectsOriginal: false,
  },
  {
    name: "string constraint",
    mutate(schema) { schema.properties.preview.minLength = 5; },
    accepted: () => ({ ...validArtifact(), preview: "datum", byte_length: 5 }),
    rejectsOriginal: true,
  },
  {
    name: "post-validation limit",
    mutate(schema) { schema["x-agenc-post-validation"].ownerFieldMaxUtf8Bytes = 2; },
    accepted: () => ({ ...validArtifact(), owner: { run_id: "r", workflow_id: "w", producer_step_id: "s" } }),
    rejectsOriginal: true,
  },
];

describe("exact public workflow handoff generation", () => {
  it("renders the complete committed file from the real runtime authority", async () => {
    expect(renderWorkflowHandoffGenerated(JSON.parse(await readFile(schemaFile, "utf8")), await readFile(runtimeFile, "utf8"))).toBe(await readFile(publicFile, "utf8"));
  });

  it.each(mutations)("detects $name drift and regenerates its validator", async ({ mutate, accepted, rejectsOriginal }) => {
    const { root, schema, options } = await createFixture();
    const original = await readFile(options.generatedPath, "utf8");
    mutate(schema);
    await writeFile(options.schemaPath, JSON.stringify(schema));
    await writeFile(options.runtimeSourcePath, fixtureRuntimeSource(schema));
    expect(await synchronizeWorkflowHandoffGenerated(options)).toMatchObject({ matches: false, changed: false });
    expect(await readFile(options.generatedPath, "utf8")).toBe(original);
    expect(await synchronizeWorkflowHandoffGenerated({ ...options, write: true })).toMatchObject({ matches: true, changed: true });
    expect(await synchronizeWorkflowHandoffGenerated(options)).toMatchObject({ matches: true, changed: false });
    expect(await synchronizeWorkflowHandoffGenerated({ ...options, write: true })).toMatchObject({ matches: true, changed: false });
    expect(await validateGenerated(root, accepted())).toEqual({ valid: true });
    if (rejectsOriginal) expect(await validateGenerated(root, validArtifact())).toMatchObject({ valid: false, name: "WorkflowHandoffArtifactValidationError", code: "WORKFLOW_HANDOFF_SCHEMA" });
  });

  it("accepts CRLF without rewriting during checks and writes canonical LF", async () => {
    const { options } = await createFixture();
    const original = await readFile(options.generatedPath, "utf8");
    await writeFile(options.generatedPath, original.replaceAll("\n", "\r\n"));
    expect(await synchronizeWorkflowHandoffGenerated(options)).toMatchObject({ matches: true, changed: false });
    expect(await readFile(options.generatedPath, "utf8")).toContain("\r\n");
    await synchronizeWorkflowHandoffGenerated({ ...options, write: true });
    expect(await readFile(options.generatedPath, "utf8")).toBe(original);
  });

  it("runs the read-only generator from SDK build and validation", async () => {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "packages/agenc-sdk/package.json"), "utf8"));
    expect(manifest.scripts["check:generated"]).toBe("node ../../runtime/scripts/check-sdk-generated-types.mjs --check");
    expect(manifest.scripts.build).toMatch(/^npm run check:generated && /u);
    expect(manifest.scripts.typecheck).toMatch(/^npm run check:generated && /u);
    expect(manifest.dependencies).toBeUndefined();
  });

  it("does not evaluate unsupported runtime authority expressions", async () => {
    const schema = JSON.parse(await readFile(schemaFile, "utf8"));
    const source = fixtureRuntimeSource(schema).replace("MAX_WORKFLOW_STEP_RESULT_TOKENS = 131072;", "MAX_WORKFLOW_STEP_RESULT_TOKENS = (() => { throw new Error('executed'); })();");
    expect(() => renderWorkflowHandoffGenerated(schema, source)).toThrow(/unsupported handoff authority expression/);
  });

  it("rejects invalid regex syntax before writing a generated validator", async () => {
    const { schema, options } = await createFixture();
    const original = await readFile(options.generatedPath, "utf8");
    schema.properties.preview.pattern = "[";
    await writeFile(options.schemaPath, JSON.stringify(schema));
    await writeFile(options.runtimeSourcePath, fixtureRuntimeSource(schema));
    await expect(synchronizeWorkflowHandoffGenerated({ ...options, write: true })).rejects.toThrow(SyntaxError);
    expect(await readFile(options.generatedPath, "utf8")).toBe(original);
  });

  it.each(["optional owner", "owner value type", "storage prefix"])("rejects unsupported handwritten relationship changes to %s", async (kind) => {
    const { schema, options } = await createFixture();
    if (kind === "optional owner") schema.required = schema.required.filter((name) => name !== "owner");
    else if (kind === "owner value type") schema.properties.owner.properties!.run_id = { type: "integer" };
    else schema.properties.storage_ref.pattern = "^other:wh_[0-9a-f]{48}$";
    await writeFile(options.schemaPath, JSON.stringify(schema));
    await writeFile(options.runtimeSourcePath, fixtureRuntimeSource(schema));
    await expect(synchronizeWorkflowHandoffGenerated({ ...options, write: true })).rejects.toThrow(/unsupported.*relationship/);
  });

  it("rejects schema-only and constant-only authority drift without writing", async () => {
    const { schema, options } = await createFixture();
    const original = await readFile(options.generatedPath, "utf8");
    schema.properties.preview.minLength = 1;
    await writeFile(options.schemaPath, JSON.stringify(schema));
    await expect(synchronizeWorkflowHandoffGenerated({ ...options, write: true })).rejects.toThrow(/schemas disagree/);
    const source = fixtureRuntimeSource(schema).replace("MAX_WORKFLOW_STEP_RESULT_TOKENS = 131072;", "MAX_WORKFLOW_STEP_RESULT_TOKENS = 131073;");
    await writeFile(options.runtimeSourcePath, source);
    await expect(synchronizeWorkflowHandoffGenerated({ ...options, write: true })).rejects.toThrow(/constant.*disagrees/);
    expect(await readFile(options.generatedPath, "utf8")).toBe(original);
  });

  it.each(["unknown structural constraint", "unknown post-validation constraint", "unsupported post-validation flag"])("rejects %s instead of omitting it", async (kind) => {
    const { schema, options } = await createFixture();
    const original = await readFile(options.generatedPath, "utf8");
    if (kind === "unknown structural constraint") schema.properties.preview.format = "uri";
    else if (kind === "unknown post-validation constraint") schema["x-agenc-post-validation"].newConstraint = true;
    else schema["x-agenc-post-validation"].requireWellFormedUnicode = false;
    await writeFile(options.schemaPath, JSON.stringify(schema));
    await writeFile(options.runtimeSourcePath, fixtureRuntimeSource(schema));
    await expect(synchronizeWorkflowHandoffGenerated({ ...options, write: true })).rejects.toThrow(/unsupported/);
    expect(await readFile(options.generatedPath, "utf8")).toBe(original);
  });
});
