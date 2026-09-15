import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import type { ExecutionEnvironment } from "../../src/execution/types.js";
import { resolveLiveInstructionEnvelope } from "../../src/prompts/live-instructions.js";
import { getGlobalMemoryEntrypoint, getProjectMemoryEntrypoint } from "../../src/memory/paths.js";
import { resolveAutoMemoryDirectory } from "../../src/services/extractMemories/memory-paths.js";
import { getPersonaMemoryFiles } from "../../src/memory/persona.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import { isCanonicalRolloutPayload } from "../../src/state/recovery-journal-schema.js";

/** Production live resolver with real task files; session/provider execution remains a fixture. */
export async function liveInstructionProbe(environment: ExecutionEnvironment, root: string,
  python: (source: string, args?: readonly string[]) => Promise<Buffer>): Promise<void> {
  const home = await mkdtemp("/controller/live-home-"), project = root + "/live";
  await mkdir(project, { recursive: true });
  try {
    await writeFile(project + "/AGENC.md", "host guidance shadow");
    await writeFile(project + "/USER.md", "host persona shadow");
    await writeFile(join(home, "AGENC.md"), "controller user guidance");
    await python("import os,sys\nr=sys.argv[1]; os.makedirs(r+'/.git/objects'); os.mkdir(r+'/.git/refs')\n" +
      "open(r+'/.git/HEAD','w').write('ref: refs/heads/main\\n')\n" +
      "open(r+'/AGENC.md','w').write('task live guidance')\n" +
      "open(r+'/USER.md','w').write('task live persona')\n" +
      "open(r+'/BOOTSTRAP.md','w').write('task live ritual')\n" +
      "open(r+'/SOUL.md','w').write('persona line\\r\\n'*2000)", [project]);
    const store = new ConfigStore({ home, env: { AGENC_HOME: home, HOME: "/controller" }, cwd: project, projectRoot: project,
      managedConfigPath: join(home, "managed.toml"), managedDropInDir: join(home, "managed.d"),
      workspaceFilesystem: new ExecutionConfigFilesystem(environment) });
    await store.reload();
    assert.equal(store.executionWorkspace!.memoryProjectRoot, project);
    const entrypoints = runWithCanonicalSettingsAuthority(store, () => [getGlobalMemoryEntrypoint(), getProjectMemoryEntrypoint()]);
    for (const [i, path] of entrypoints.entries()) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `controller index ${i}`); }
    const extraction = await resolveAutoMemoryDirectory({ configStore: store, cwd: project, env: { AGENC_HOME: home, HOME: "/controller" } });
    assert.equal(join(extraction.path!, "MEMORY.md"), entrypoints[1]);
    const manager = new UnifiedExecProcessManager({ executionEnvironment: environment, cwd: project, baseEnv: {}, sessionTempRoot: home });
    const session = { services: { configStore: store, unifiedExecManager: manager },
      permissionModeRegistry: { current: () => ({ additionalWorkingDirectories: new Map() }) },
      setProjectMemoryWarnings() {} } as unknown as Session;
    const envelope = await runWithCanonicalSettingsAuthority(store, () => resolveLiveInstructionEnvelope({ session,
      ctx: { cwd: project } as TurnContext, baseInstructions: "trusted fixture base" }));
    assert.match(envelope.text, /task live guidance/); assert.match(envelope.text, /task live persona/);
    assert.match(envelope.text, /task live ritual/); assert.match(envelope.text, /controller user guidance/);
    assert.match(envelope.memoryText, /controller index 1/);
    assert.doesNotMatch(envelope.text, /host guidance shadow|host persona shadow/);
    assert.ok(envelope.sources.filter((source) => source.repositoryControlled).every((source) => source.executionBinding?.kind === "docker"));
    assert.ok(isCanonicalRolloutPayload("turn_context", { cwd: project, approvalPolicy: "never", sandboxPolicy: "container",
      model: "fixture", instructionEvidence: envelope.evidence }));
    const persona = await getPersonaMemoryFiles(project, new Set(), environment);
    assert.ok(persona.find((file) => file.path.endsWith("SOUL.md"))?.rawContent?.includes("\r\n"));
    await python("import sys; open(sys.argv[1]+'/IDENTITY.md','w').write('task identity')", [project]);
    assert.ok(!(await getPersonaMemoryFiles(project, new Set(), environment)).some((file) => file.path.endsWith("BOOTSTRAP.md")));
    // This fixture did not start manager-owned commands; the enclosing probe
    // owns the environment and closes it after the remaining kernel checks.
    console.log("Real live prompt: task guidance/persona, task identity gate, controller memory authority, extraction-path agreement and durable environment provenance passed");
  } finally { await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); }
}
