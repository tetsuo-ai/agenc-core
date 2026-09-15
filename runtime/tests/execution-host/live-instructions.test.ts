import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import { executionWorkspaceStorageKey, prepareExecutionWorkspace } from "../../src/execution/workspace.js";
import { clearTieredInstructionsCacheForTesting } from "../../src/prompts/agenc-md.js";
import { resolveLiveInstructionEnvelope } from "../../src/prompts/live-instructions.js";
import { getPersonaMemoryFiles, PERSONA_FILE_MAX_BYTES } from "../../src/memory/persona.js";
import { getGlobalMemoryEntrypoint, getProjectMemoryEntrypoint, getProjectMemoryPath } from "../../src/memory/paths.js";
import { resolveAutoMemoryDirectory } from "../../src/services/extractMemories/memory-paths.js";
import { isCanonicalEventPayload, isCanonicalRolloutPayload } from "../../src/state/recovery-journal-schema.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import { resetCanonicalSettingsAuthorityForTesting, runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { TaskFiles } from "./task-files-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  clearTieredInstructionsCacheForTesting();
  resetCanonicalSettingsAuthorityForTesting();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function controller() {
  const root = await mkdtemp(join(tmpdir(), "agenc-live-environment-")); roots.push(root);
  const home = join(root, "home"); await mkdir(home);
  return { root, home };
}
async function storeFor(host: Awaited<ReturnType<typeof controller>>, files: TaskFiles, cwd: string, digit = "a") {
  const store = new ConfigStore({ home: host.home, env: { AGENC_HOME: host.home, HOME: host.root }, cwd, projectRoot: cwd,
    managedConfigPath: join(host.root, "managed", "config.toml"), managedDropInDir: join(host.root, "managed.d"),
    workspaceFilesystem: new ExecutionConfigFilesystem(files.environment(digit)) });
  await store.reload();
  return store;
}
function sessionFor(store: ConfigStore): Session {
  return { services: { configStore: store, unifiedExecManager: { executionEnvironmentBinding: store.executionWorkspace!.environment.binding } },
    permissionModeRegistry: { current: () => ({ additionalWorkingDirectories: new Map() }) },
    setProjectMemoryWarnings: vi.fn() } as unknown as Session;
}
function envelope(store: ConfigStore, session = sessionFor(store)) {
  return runWithCanonicalSettingsAuthority(store, () => resolveLiveInstructionEnvelope({ session,
    ctx: { cwd: store.projectRoot } as TurnContext, baseInstructions: "trusted base" }));
}
function gitDirectory(files: TaskFiles, path: string) {
  files.put(path + "/HEAD", "ref: refs/heads/main");
  files.put(path + "/objects", "", true); files.put(path + "/refs", "", true);
}
function worktree(files: TaskFiles, root: string, common: string, name = "side") {
  const privateDir = common + "/worktrees/" + name;
  files.put(root + "/.git", "gitdir: " + privateDir);
  files.put(privateDir + "/commondir", "../..");
  files.put(privateDir + "/gitdir", root + "/.git");
}

it("assembles task instructions/persona with controller memory indexes and durable binding evidence", async () => {
  const host = await controller(), files = new TaskFiles();
  const project = join(host.root, "project"); await mkdir(project);
  await writeFile(join(project, "AGENC.md"), "host instruction shadow");
  await writeFile(join(project, "USER.md"), "host persona shadow");
  await writeFile(join(host.home, "AGENC.md"), "controller user guidance");
  files.put(project + "/AGENC.md", "task instruction"); files.put(project + "/USER.md", "task persona");
  const store = await storeFor(host, files, project), session = sessionFor(store);
  const memoryPaths = runWithCanonicalSettingsAuthority(store, () => [getGlobalMemoryEntrypoint(), getProjectMemoryEntrypoint()]);
  for (const [i, path] of memoryPaths.entries()) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `controller memory index ${i}`); }
  const result = await envelope(store, session);
  expect(result.text).toContain("task instruction"); expect(result.text).toContain("task persona");
  expect(result.text).toContain("controller user guidance"); expect(result.text).toContain("controller memory index 1");
  expect(result.text).not.toContain("host instruction shadow"); expect(result.text).not.toContain("host persona shadow");
  expect(result.sources.filter((source) => source.repositoryControlled).every((source) =>
    source.executionBinding?.kind === "docker")).toBe(true);
  expect(result.sources.find((source) => source.path.endsWith("/USER.md"))?.executionBinding).toEqual(files.environment().binding);
  const payload = { cwd: project, approvalPolicy: "never", sandboxPolicy: "container", model: "fixture", instructionEvidence: result.evidence };
  expect(isCanonicalEventPayload("turn_context", payload)).toBe(true);
  expect(isCanonicalRolloutPayload("turn_context", payload)).toBe(true);
  const corrupt = { ...payload, instructionEvidence: { ...result.evidence,
    sources: [{ ...result.sources[0], executionBinding: { kind: "docker" } }] } };
  expect(isCanonicalRolloutPayload("turn_context", corrupt)).toBe(false);
  const extraction = await resolveAutoMemoryDirectory({ configStore: store, cwd: project, env: { HOME: host.root, AGENC_HOME: host.home } });
  expect(extraction.path).toBe(runWithCanonicalSettingsAuthority(store, getProjectMemoryPath));
  files.unavailable = true;
  await expect(envelope(store, session)).rejects.toMatchObject({ code: "environment_dead" });
});

it("separates memory and prompt heads for equal /app paths and refuses a mismatched process authority", async () => {
  const host = await controller();
  const one = new TaskFiles(), two = new TaskFiles(); one.put("/app/AGENC.md", "task one"); two.put("/app/AGENC.md", "task two");
  const first = await storeFor(host, one, "/app"), second = await storeFor(host, two, "/app", "d");
  const memoryOne = runWithCanonicalSettingsAuthority(first, getProjectMemoryPath);
  const memoryTwo = runWithCanonicalSettingsAuthority(second, getProjectMemoryPath);
  expect(memoryOne).not.toBe(memoryTwo);
  expect(memoryOne).toContain(executionWorkspaceStorageKey(one.environment().binding, "/app"));
  const session = sessionFor(first);
  expect((await envelope(first, session)).text).toContain("task one");
  const firstScope = getAttachmentTrackingState(session).instructionHeadScope;
  Object.assign(session.services, { configStore: second });
  await expect(envelope(second, session)).rejects.toMatchObject({ code: "execution_environment_changed" });
  // Simulate reusing persisted attachment state with a newly validated owner.
  Object.assign(session.services, sessionFor(second).services);
  const changed = await envelope(second, session);
  expect(changed.text).toContain("task two"); expect(changed.text).not.toContain("task one");
  expect(getAttachmentTrackingState(session).instructionHeadScope).not.toBe(firstScope);
});

it("uses the session memory authority when another configuration is ambient", async () => {
  const host = await controller(), one = new TaskFiles(), two = new TaskFiles();
  one.put("/app/AGENC.md", "one"); two.put("/app/AGENC.md", "two");
  const first = await storeFor(host, one, "/app"), second = await storeFor(host, two, "/app", "d");
  const firstIndex = runWithCanonicalSettingsAuthority(first, getProjectMemoryEntrypoint);
  const secondIndex = runWithCanonicalSettingsAuthority(second, getProjectMemoryEntrypoint);
  for (const [path, text] of [[firstIndex, "first owner memory"], [secondIndex, "foreign owner memory"]]) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
  }
  const result = await runWithCanonicalSettingsAuthority(second, () => resolveLiveInstructionEnvelope({ session: sessionFor(first),
    ctx: { cwd: "/app" } as TurnContext, baseInstructions: "base" }));
  expect(result.memoryText).toContain("first owner memory");
  expect(result.memoryText).not.toContain("foreign owner memory");
});

it("resolves validated worktree and bare roots in the task and rolls workspace metadata back with config", async () => {
  const files = new TaskFiles(), host = await controller();
  files.put("/app", "", true);
  const store = await storeFor(host, files, "/app");
  expect(store.executionWorkspace!.memoryProjectRoot).toBe("/app");
  gitDirectory(files, "/main/.git"); worktree(files, "/app", "/main/.git");
  const prepared = await store.prepareReload();
  expect(prepared.authority.executionWorkspace!.memoryProjectRoot).toBe("/main");
  expect(store.executionWorkspace!.memoryProjectRoot).toBe("/app");
  prepared.commit(); expect(store.executionWorkspace!.memoryProjectRoot).toBe("/main");
  prepared.rollback(); prepared.settle(); expect(store.executionWorkspace!.memoryProjectRoot).toBe("/app");
  files.put("/main/.git/worktrees/side/gitdir", "/other/.git");
  expect((await prepareExecutionWorkspace(files.environment(), "/app")).memoryProjectRoot).toBe("/app");
  gitDirectory(files, "/bare.git"); worktree(files, "/checkout", "/bare.git");
  expect((await prepareExecutionWorkspace(files.environment(), "/checkout")).memoryProjectRoot).toBe("/bare.git");
  files.unavailable = true;
  await expect(prepareExecutionWorkspace(files.environment(), "/app")).rejects.toMatchObject({ code: "environment_dead" });
});

it("preserves task persona truncation/raw bytes and gates bootstrap using task identity", async () => {
  const files = new TaskFiles();
  const raw = "\ufeffpersona\r\n" + "α\r\n".repeat(PERSONA_FILE_MAX_BYTES);
  files.put("/app/SOUL.md", raw); files.put("/app/BOOTSTRAP.md", "task ritual");
  const initial = await getPersonaMemoryFiles("/app", new Set(), files.environment());
  expect(initial.find((file) => file.path.endsWith("SOUL.md"))).toMatchObject({ rawContent: raw, contentDiffersFromDisk: true });
  expect(initial[0].content).toContain("SOUL.md truncated for context");
  expect(initial.find((file) => file.path.endsWith("BOOTSTRAP.md"))?.content).toContain("task ritual");
  files.put("/app/IDENTITY.md", "task identity");
  expect((await getPersonaMemoryFiles("/app", new Set(), files.environment())).some((file) => file.path.endsWith("BOOTSTRAP.md"))).toBe(false);
  const dedup = new Set(["/app/SOUL.md"]);
  expect((await getPersonaMemoryFiles("/app", dedup, files.environment())).some((file) => file.path.endsWith("SOUL.md"))).toBe(false);
});

it("loads additional-directory guidance in the same environment and rejects relative task directory selectors", async () => {
  vi.stubEnv("AGENC_ADDITIONAL_DIRECTORIES_AGENC_MD", "1");
  const host = await controller(), files = new TaskFiles();
  files.put("/app/AGENC.md", "primary guidance"); files.put("/extra/AGENC.md", "additional task guidance");
  const store = await storeFor(host, files, "/app"), session = sessionFor(store);
  const directories = new Map([["extra", { source: "cliArg", path: "/extra" }]]);
  Object.assign(session, { permissionModeRegistry: { current: () => ({ additionalWorkingDirectories: directories }) } });
  const loaded = await envelope(store, session);
  expect(loaded.text).toContain("additional task guidance");
  expect(loaded.sources.find((source) => source.path === "/extra/AGENC.md")?.executionBinding).toEqual(files.environment().binding);
  directories.set("extra", { source: "cliArg", path: "relative" });
  await expect(envelope(store, session)).rejects.toThrow("Task instruction directories must be absolute");
});
