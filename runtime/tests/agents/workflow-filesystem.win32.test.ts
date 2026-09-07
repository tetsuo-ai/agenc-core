import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadNamedWorkflowManifest } from "../../src/agents/workflow-manifest.js";
import { WorkflowHandoffArtifactStore } from "../../src/agents/workflow-handoff-store.js";
import { assertWindowsPrivatePathSecurity } from "../../src/agents/workflow-private-path.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import {
  resolveTrustedWindowsSystemExecutable,
  resolveTrustedWindowsSystemPaths,
} from "../../src/utils/windows-system-path.js";

if (process.platform !== "win32") {
  throw new Error("workflow filesystem native tests require Windows");
}

const manifest = '{"format_version":2,"kind":"agent_dag","steps":[{"id":"step","message":"work"}]}';
const owner = { run_id: "run", workflow_id: "workflow", producer_step_id: "step" };
let temporaryDirectory: string;
let driver: StateSqliteDriver | undefined;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "agenc-workflow-win32-"));
});

afterEach(async () => {
  driver?.close();
  driver = undefined;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

it("loads regular and hard-linked shared manifests on Windows", async () => {
  const root = join(temporaryDirectory, "manifests");
  await mkdir(root);
  await writeFile(join(root, "example.json"), manifest);
  await link(join(root, "example.json"), join(root, "linked.json"));
  for (const name of ["example", "linked"]) {
    const loaded = await loadNamedWorkflowManifest({ name, roots: [root] });
    expect(loaded.document.manifest.steps[0]?.id).toBe("step");
  }
});

it("rejects a Windows manifest root replaced after opening", async () => {
  const root = join(temporaryDirectory, "manifests");
  await mkdir(root);
  await writeFile(join(root, "example.json"), manifest);
  await expect(loadNamedWorkflowManifest({
    name: "example", roots: [root],
    hooks: {
      async afterRootOpen() {
        await rename(root, `${root}.old`);
        await mkdir(root);
        await writeFile(join(root, "example.json"), manifest);
      },
    },
  })).rejects.toMatchObject({ code: "WORKFLOW_ROOT_RACE" });
});

it("rejects a Windows manifest child replaced after opening", async () => {
  const root = join(temporaryDirectory, "manifests");
  const candidate = join(root, "example.json");
  await mkdir(root);
  await writeFile(candidate, manifest);
  await expect(loadNamedWorkflowManifest({
    name: "example", roots: [root],
    hooks: {
      async afterCandidateOpen() {
        await rename(candidate, `${candidate}.old`);
        await writeFile(candidate, manifest);
      },
    },
  })).rejects.toMatchObject({ code: "WORKFLOW_MANIFEST_RACE" });
});

it("rejects Windows junction roots in both workflow consumers", async () => {
  const target = join(temporaryDirectory, "target");
  const alias = join(temporaryDirectory, "alias");
  await mkdir(target);
  await writeFile(join(target, "example.json"), manifest);
  await symlink(target, alias, "junction");
  await expect(loadNamedWorkflowManifest({ name: "example", roots: [alias] }))
    .rejects.toMatchObject({ code: "WORKFLOW_ROOT_UNSAFE" });
  driver = openStateDatabases({ cwd: temporaryDirectory, agencHome: join(temporaryDirectory, "home") });
  expect(() => new WorkflowHandoffArtifactStore({ driver: driver!, trustedRoot: alias }))
    .toThrow(expect.objectContaining({ code: "WORKFLOW_HANDOFF_UNSAFE_ROOT" }));
});

it("reads and cleans private Windows handoffs while rejecting hard links", async () => {
  driver = openStateDatabases({ cwd: temporaryDirectory, agencHome: join(temporaryDirectory, "home") });
  const root = join(temporaryDirectory, "handoffs");
  let now = 1_000_000;
  const store = new WorkflowHandoffArtifactStore({
    driver, trustedRoot: root, retentionMs: 100, now: () => now,
    hooks: {
      async afterIntentReserved(artifactId) {
        const candidate = join(root, `${artifactId}.handoff`);
        await writeFile(candidate, "safe");
        assertWindowsPrivatePathSecurity(candidate, "file", true);
      },
    },
  });
  const artifact = await store.publish({ owner, idempotencyKey: "item", bytes: Buffer.from("safe"), tokenCount: 1 });
  expect(Buffer.from((await store.read(artifact.artifact_id)).bytes))
    .toEqual(Buffer.from("safe"));
  const candidate = join(root, `${artifact.artifact_id}.handoff`);
  const alias = join(temporaryDirectory, "hard-link");
  await link(candidate, alias);
  await expect(store.read(artifact.artifact_id)).rejects.toMatchObject({ code: "WORKFLOW_HANDOFF_CORRUPT" });
  expect(await readFile(alias, "utf8")).toBe("safe");
  await unlink(alias);
  now += 200;
  expect(await store.cleanupExpired()).toMatchObject({ removed: 1, conflicts: 0 });
  await expect(readFile(candidate)).rejects.toMatchObject({ code: "ENOENT" });
}, 90_000);

it("verifies a streamed Windows publication against an existing bounded candidate", async () => {
  driver = openStateDatabases({ cwd: temporaryDirectory, agencHome: join(temporaryDirectory, "home") });
  const root = join(temporaryDirectory, "handoffs");
  const bytes = Buffer.alloc(131_072, 97);
  const store = new WorkflowHandoffArtifactStore({
    driver, trustedRoot: root,
    hooks: {
      async afterIntentReserved(artifactId) {
        const candidate = join(root, `${artifactId}.handoff`);
        await writeFile(candidate, bytes);
        assertWindowsPrivatePathSecurity(candidate, "file", true);
        await link(candidate, `${candidate}.pending`);
      },
      async afterArtifactInstalled(artifactId) {
        await unlink(join(root, `${artifactId}.handoff.pending`));
      },
    },
  });
  const artifact = await store.publishSource({
    owner, idempotencyKey: "stream", tokenCount: 1,
    source: {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      async *chunks() {
        yield bytes.subarray(0, 65_536);
        yield bytes.subarray(65_536);
      },
    },
  });
  expect(Buffer.from((await store.read(artifact.artifact_id)).bytes)).toEqual(bytes);
}, 90_000);

it("continues Windows cleanup after rejecting one inherited file ACL", async () => {
  driver = openStateDatabases({
    cwd: temporaryDirectory, agencHome: join(temporaryDirectory, "home"),
  });
  let now = 1_000_000;
  const root = join(temporaryDirectory, "handoffs");
  const store = new WorkflowHandoffArtifactStore({
    driver, trustedRoot: root, retentionMs: 100, now: () => now,
  });
  const rejected = await store.publish({
    owner, idempotencyKey: "rejected", bytes: Buffer.from("bad-acl"), tokenCount: 1,
  });
  const accepted = await store.publish({
    owner, idempotencyKey: "accepted", bytes: Buffer.from("private"), tokenCount: 1,
  });
  const rejectedPath = join(root, `${rejected.artifact_id}.handoff`);
  const icacls = resolveTrustedWindowsSystemExecutable(
    resolveTrustedWindowsSystemPaths(), ["System32", "icacls.exe"],
  );
  execFileSync(icacls, [rejectedPath, "/inheritance:e"], { windowsHide: true });
  await expect(store.read(rejected.artifact_id))
    .rejects.toMatchObject({ code: "WORKFLOW_HANDOFF_CORRUPT" });
  now += 101;
  expect(await store.cleanupExpired()).toMatchObject({ removed: 1, conflicts: 1 });
  expect(await readFile(rejectedPath, "utf8")).toBe("bad-acl");
  await expect(readFile(join(root, `${accepted.artifact_id}.handoff`)))
    .rejects.toMatchObject({ code: "ENOENT" });
}, 90_000);
