import { getAgentMemoryDir } from "../../src/tools/AgentTool/agentMemory.js";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { ExecutionEnvironment } from "../../src/execution/types.js";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { loadFreshAgentDefinitions } from "../../src/tools/AgentTool/loadAgentsDir.js";
import { createAgentRoleWorkspace, registerAgentRole, loadRoleLayerToml } from "../../src/agents/role.js";
import { AgentRoleCatalog } from "../../src/agents/role-catalog.js";
import { executionMarkdownDirectories, readExecutionMarkdownTier } from "../../src/execution/markdown-content.js";
import { loadMarkdownFilesForSubdirFresh } from "../../src/utils/markdownConfigLoader.js";
import { checkReadPermissionForTool, checkWritePermissionForTool } from "../../src/utils/permissions/filesystem.js";
import { runWithAgentMemoryAuthorization } from "../../src/utils/agentContext.js";
import type { Tool, ToolPermissionContext } from "../../src/tools/Tool.js";
import { checkToolPathPermissionAsync } from "../../src/permissions/path-validation.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { clearSessionReadState, getSessionReadSnapshot, withSignedSessionId } from "../../src/tools/system/filesystem.js";
import { changedFilesProducer } from "../../src/prompts/attachments/changed-files.js";
import type { GetAttachmentsOptions } from "../../src/prompts/attachments/orchestrator.js";
import { buildFileWriteApprovalPreview } from "../../src/permissions/file-write-preview.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import { canonicalWorkspaceRoot, workspaceMutationCoordinators, WorkspaceMutationCoordinatorRegistry } from "../../src/workspace/mutation-coordinator.js";
import { ExecutionCoordinatorPaths } from "../../src/execution/coordinator-paths.js";
import { createHash } from "node:crypto";
import { workspaceTransactionProbe } from "./workspace-transaction-probe.js";

export async function roleContentProbe(environment: ExecutionEnvironment, root: string,
  python: (source: string, args?: readonly string[]) => Promise<Buffer>): Promise<void> {
  const workspaceRoot = root + "/role-content", home = workspaceRoot + "/.agenc";
  const directory = home + "/agents", pluginStorageRoot = home + "/plugins";
  await python("import os,sys\nr=sys.argv[1]; p=r+'/.agenc/agents'; os.makedirs(p)\n" +
    "open(p+'/shared.md','w').write('---\\nname: task-reviewer\\ndescription: Task reviewer\\n---\\nTask role guidance α')\n" +
    "os.symlink(p+'/shared.md',p+'/link.md'); os.link(p+'/shared.md',p+'/hard.md')\n" +
    "open(p+'/safe.md','w').write('---\\nname: task-safe\\ndescription: Safe task reviewer\\n---\\nProtected role β')\n" +
    "open(r+'/role.toml','w').write('model = \\\"task-model\\\"\\n')", [workspaceRoot]);
  await mkdir(directory, { recursive: true });
  await writeFile(directory + "/safe.md", "---\nname: operator-reviewer\ndescription: Operator reviewer\n---\nController role guidance");
  await writeFile(workspaceRoot + "/role.toml", 'model = "host-shadow"\n');
  try {
    const store = new ConfigStore({ home, cwd: workspaceRoot, projectRoot: workspaceRoot,
      workspaceFilesystem: new ExecutionConfigFilesystem(environment) });
    await store.reload();
    await runWithCanonicalSettingsAuthority(store, async () => {
      assert.deepEqual(await executionMarkdownDirectories("agents", workspaceRoot, store.executionWorkspace!), [directory]);
      assert.deepEqual((await readExecutionMarkdownTier(directory, environment)).map(file => file.filePath), [directory + "/safe.md"]);
      const markdown = await loadMarkdownFilesForSubdirFresh("agents", workspaceRoot);
      assert.ok(markdown.some(file => file.executionBinding && file.frontmatter.name === "task-safe"),
        JSON.stringify(markdown.map(file => ({ path: file.filePath, name: file.frontmatter.name, source: file.source, binding: file.executionBinding }))));
      const workspace = createAgentRoleWorkspace(workspaceRoot, environment.binding);
      registerAgentRole(workspace, { name: "task-toml", config: { configFile: workspaceRoot + "/role.toml" } });
      const definitions = await loadFreshAgentDefinitions(workspaceRoot, pluginStorageRoot);
      assert.deepEqual(definitions.failedFiles ?? [], [], "Role discovery must not hide source failures");
      assert.deepEqual(definitions.activeAgents.find(agent => agent.agentType === "task-safe")?.executionBinding, environment.binding);
      assert.equal(definitions.activeAgents.find(agent => agent.agentType === "operator-reviewer")?.executionBinding, undefined);
      assert.equal(definitions.activeAgents.find(agent => agent.agentType === "task-reviewer"), undefined, "Hard-linked task roles must not load");
      const catalog = new AgentRoleCatalog(workspace, definitions);
      assert.equal(catalog.require("task-safe").config.systemPrompt, "Protected role β");
      assert.equal(catalog.require("operator-reviewer").config.systemPrompt, "Controller role guidance");
      const captured = catalog.require("task-toml");
      assert.equal(loadRoleLayerToml(captured).model, "task-model");
      const fingerprint = catalog.fingerprint(captured);
      await python("import sys\nopen(sys.argv[1]+'/role.toml','w').write('model = \\\"fresh-model\\\"\\n')", [workspaceRoot]);
      const fresh = new AgentRoleCatalog(workspace, await loadFreshAgentDefinitions(workspaceRoot, pluginStorageRoot));
      assert.equal(loadRoleLayerToml(fresh.require("task-toml")).model, "fresh-model");
      assert.notEqual(fresh.fingerprint(fresh.require("task-toml")), fingerprint);
      assert.equal(loadRoleLayerToml(captured).model, "task-model");
      assert.equal(catalog.fingerprint(captured), fingerprint);
      const readPath = workspaceRoot + "/read.txt", readSession = "protected-file-read-" + environment.binding.generation;
      await writeFile(readPath, "controller read shadow");
      await python("import os,sys,json\nr=sys.argv[1]\nopen(r+'/read.txt','w').write('task read α\\nsecond β\\nthird γ\\n')\n" +
        "os.mkdir(r+'/read-dir'); os.symlink(r+'/read-dir',r+'/read-alias')\n" +
        "open(r+'/read-dir/cross.txt','w').write('cross-directory target')\n" +
        "os.symlink(r+'/read-dir/cross.txt',r+'/cross-link')\n" +
        "open(r+'/read.ipynb','w').write(json.dumps({'nbformat':4,'metadata':{},'cells':[{'cell_type':'markdown','metadata':{},'source':['protected notebook δ']}]}))", [workspaceRoot]);
      try {
        const reader = createFileReadTool({ allowedPaths: [workspaceRoot], maxTokens: 25_000 });
        const actual = await reader.execute(withSignedSessionId({ file_path: workspaceRoot + "/read-alias/../read.txt" }, readSession));
        assert.notEqual(actual.isError, true, JSON.stringify(actual));
        assert.ok(actual.content.includes("task read α")); assert.ok(!actual.content.includes("controller read shadow"));
        assert.deepEqual(getSessionReadSnapshot(readSession, readPath)?.executionBinding, environment.binding);
        const previewInvocation = { turn: { cwd: workspaceRoot }, session: { conversationId: readSession,
          services: { permissionModeRegistry: { current: () => createEmptyToolPermissionContext() } } } } as unknown as ToolInvocation;
        const preview = () => buildFileWriteApprovalPreview(previewInvocation, { file_path: readPath });
        assert.deepEqual(await preview(), { kind: "existing", content: "task read α\nsecond β\nthird γ\n" });
        await writeFile(workspaceRoot + "/missing-preview.txt", "controller-only file");
        assert.deepEqual(await buildFileWriteApprovalPreview(previewInvocation, { file_path: workspaceRoot + "/missing-preview.txt" }), { kind: "missing" });
        const partial = await reader.execute(withSignedSessionId({ file_path: readPath, offset: 2, limit: 1 }, readSession));
        assert.notEqual(partial.isError, true, JSON.stringify(partial)); assert.ok(partial.content.includes("second β"));
        assert.ok(!partial.content.includes("task read α"));
        assert.equal(getSessionReadSnapshot(readSession, readPath)?.rawContent, undefined);
        assert.equal((await preview()).kind, "unavailable");
        const notebook = await reader.execute(withSignedSessionId({ file_path: workspaceRoot + "/read.ipynb" }, readSession));
        assert.notEqual(notebook.isError, true, JSON.stringify(notebook)); assert.ok(notebook.content.includes("protected notebook δ"));
        // Public capabilities must also preserve legitimate cross-directory leaf aliases.
        const alias = await environment.filesystem.bindFileRead(workspaceRoot + "/cross-link");
        try {
          assert.equal((await alias.describe()).canonicalPath, workspaceRoot + "/read-dir/cross.txt");
          assert.equal((await alias.readFile(100)).content.toString(), "cross-directory target");
        } finally { await alias.dispose(); }
        await reader.execute(withSignedSessionId({ file_path: readPath }, readSession));
        await python("import sys\nopen(sys.argv[1],'w').write('task changed ε\\n')", [readPath]);
        assert.equal((await preview()).kind, "unavailable");
        const changes = await changedFilesProducer({ sessionKey: { sessionId: readSession }, cwd: workspaceRoot,
          signal: new AbortController().signal, userInput: null, loadedTools: [], messages: [],
          permissionContext: { mode: "default" }, subagentDepth: 0 } as GetAttachmentsOptions, {} as never);
        assert.ok(JSON.stringify(changes).includes("task changed ε"), JSON.stringify(changes));
        assert.ok(!JSON.stringify(changes).includes("controller read shadow"));
        assert.equal((await preview()).kind, "unavailable", "A diff attachment cannot inherit a stale full-read snapshot");
      } finally { clearSessionReadState(readSession); }
      await writeFile(directory + "/memory.md", "---\nname: operator-memory\ndescription: Operator memory\nmemory: project\n---\nMemory role guidance");
      const memoryPath = getAgentMemoryDir("operator-memory", "project", workspaceRoot) + "MEMORY.md";
      await mkdir(memoryPath.slice(0, -"MEMORY.md".length), { recursive: true });
      await writeFile(memoryPath, "Host memory shadow");
      await python("import os,sys\np=sys.argv[1]\nos.makedirs(os.path.dirname(p))\nopen(p,'w').write('Protected task memory α')", [memoryPath]);
      const memoryCatalog = await loadFreshAgentDefinitions(workspaceRoot, pluginStorageRoot);
      const memoryRole = memoryCatalog.activeAgents.find(agent => agent.agentType === "operator-memory")!;
      assert.ok(memoryRole.getSystemPrompt().includes("Protected task memory α"));
      assert.ok(!memoryRole.getSystemPrompt().includes("Host memory shadow"));
      const fileTool = { name: "FileRead", getPath: (input: Record<string, unknown>) => String(input.file_path) } as unknown as Tool;
      const permissions = { mode: "default", additionalWorkingDirectories: new Map(), alwaysAllowRules: {},
        alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false } as ToolPermissionContext;
      await runWithAgentMemoryAuthorization({ agentType: "operator-memory", scope: "project" }, async () => {
        const canonicalPermission = (operationType: "read" | "write") => checkToolPathPermissionAsync({
          toolName: operationType === "read" ? "FileRead" : "Write", input: { file_path: memoryPath }, path: memoryPath,
          cwd: workspaceRoot, context: permissions, operationType,
        });
        assert.equal((await canonicalPermission("read")).behavior, "allow");
        assert.equal((await canonicalPermission("write")).behavior, "allow");
        for (const basename of ["'quoted'", "[private]"]) {
          const quotedPath = workspaceRoot + "/" + basename;
          await python("import sys\nopen(sys.argv[1],'w').write('literal task file')", [quotedPath]);
          assert.equal((await checkToolPathPermissionAsync({ toolName: "FileRead", input: { file_path: quotedPath },
            path: quotedPath, cwd: workspaceRoot, operationType: "read", context: { ...permissions, mode: "bypassPermissions",
              alwaysDenyRules: { session: [`FileRead(${quotedPath})`] } } })).behavior, "deny");
        }
        assert.equal((await checkReadPermissionForTool(fileTool, { file_path: memoryPath }, permissions)).behavior, "allow");
        assert.equal((await checkWritePermissionForTool(fileTool, { file_path: memoryPath }, permissions)).behavior, "allow");
        assert.equal((await checkReadPermissionForTool(fileTool, { file_path: memoryPath }, { ...permissions,
          mode: "bypassPermissions", alwaysDenyRules: { session: ["FileRead(**/MEMORY.md)"] } })).behavior, "deny");
        await python("import os,sys\np=sys.argv[1]\nos.link(p,p+'.hard')", [memoryPath]);
        assert.equal((await canonicalPermission("read")).behavior, "ask");
        assert.equal((await canonicalPermission("write")).behavior, "ask");
        assert.equal((await checkReadPermissionForTool(fileTool, { file_path: memoryPath }, { ...permissions, mode: "bypassPermissions" })).behavior, "ask");
        assert.equal((await checkWritePermissionForTool(fileTool, { file_path: memoryPath }, permissions)).behavior, "ask");
        await python("import os,sys\nos.unlink(sys.argv[1]+'.hard')", [memoryPath]);
      });
      await python("import sys\nopen(sys.argv[1],'w').write('Fresh task memory β')", [memoryPath]);
      const nextMemory = (await loadFreshAgentDefinitions(workspaceRoot, pluginStorageRoot)).activeAgents.find(agent => agent.agentType === "operator-memory")!;
      assert.ok(nextMemory.getSystemPrompt().includes("Fresh task memory β"));
      assert.ok(memoryRole.getSystemPrompt().includes("Protected task memory α"));
      await python("import os,sys\nr=sys.argv[1]+'/.agenc'\nos.rename(r+'/agent-memory',r+'/memory-target')\nos.symlink(r+'/memory-target',r+'/agent-memory')", [workspaceRoot]);
      const aliasedMemory = (await loadFreshAgentDefinitions(workspaceRoot, pluginStorageRoot)).activeAgents.find(agent => agent.agentType === "operator-memory")!;
      assert.ok(aliasedMemory.getSystemPrompt().includes("Fresh task memory β"));
      await writeFile(workspaceRoot + "/transaction.txt", "controller transaction shadow");
      await python("import sys\nopen(sys.argv[1]+'/transaction.txt','w').write('original task')", [workspaceRoot]);
      await workspaceTransactionProbe(environment, workspaceRoot, home);
      const registry = workspaceMutationCoordinators.forHome(home);
      assert.equal(await canonicalWorkspaceRoot(workspaceRoot + "/read-alias/.."), workspaceRoot);
      const editorText = "protected task editor content";
      await workspaceMutationCoordinators.preparePaths([workspaceRoot, readPath], async () => {
        const coordinator = workspaceMutationCoordinators.getOrCreate(workspaceRoot);
        assert.equal(registry.getOrCreate(workspaceRoot), coordinator);
        const lease = registry.acquireEditor(workspaceRoot, { workspaceRoot, editorInstanceId: "task-kernel-editor" });
        coordinator.sync({ workspaceRoot, editorInstanceId: "task-kernel-editor", leaseToken: lease.leaseToken,
          epoch: lease.epoch, sequence: 0, buffers: [{ path: readPath, bufferHandle: 1, changedtick: 1,
            contentSha256: createHash("sha256").update(editorText).digest("hex"), contentBytes: Buffer.byteLength(editorText),
            dirty: true, content: editorText }] });
        assert.equal(coordinator.authoritativeRead(readPath)?.content, editorText);
        await coordinator.flushQuarantinePersistence();
      });
      assert.throws(() => registry.findForPath(readPath), /protected preparation/);
      const restoredRegistry = new WorkspaceMutationCoordinatorRegistry({ agencHome: home,
        executionPaths: new ExecutionCoordinatorPaths(store.executionWorkspace!) });
      await restoredRegistry.preparePaths([workspaceRoot, readPath], async () => {
        const restored = restoredRegistry.getOrCreate(workspaceRoot);
        assert.equal(restored.authorityForPath(readPath), "stale_dirty");
        assert.equal(restoredRegistry.hasProtectedEditorAuthority(workspaceRoot), true);
        await restored.flushQuarantinePersistence();
      });
    });
    console.log("Real role content: protected markdown, controller/task source separation, symlink/hard-link rejection, bound workspace/catalog, task TOML capture, fresh fingerprints and protected agent-memory prompt capture passed");
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
}
