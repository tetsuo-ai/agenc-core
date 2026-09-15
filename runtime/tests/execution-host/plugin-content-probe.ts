import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { ContentFilesystem } from "../../src/execution/content-filesystem.js";
import type { ExecutionEnvironment } from "../../src/execution/types.js";
import { createPluginFromPath, discoverPluginSkillRootsWithProvenance, loadPlugins } from "../../src/plugins/loader.js";
import { refreshPluginRegistrations } from "../../src/plugins/registration/manager.js";
import { loadPluginCommands, loadPluginSkillDirectory } from "../../src/plugins/registration/load-plugin-commands.js";
import { createLocalSkillsServices, loadLocalSkillsSnapshot } from "../../src/skills/local-loader.js";

export async function pluginContentProbe(environment: ExecutionEnvironment, root: string,
  python: (source: string, args?: readonly string[]) => Promise<Buffer>): Promise<void> {
  const workspaceRoot = root + "/plugin-content", pluginStorageRoot = workspaceRoot + "/plugins";
  const pluginRoot = pluginStorageRoot + "/shared";
  await python("import os,sys,json\np=sys.argv[1]\nos.makedirs(p+'/.agenc-plugin'); os.makedirs(p+'/skills/example'); os.makedirs(p+'/commands')\n" +
    "open(p+'/manifest-target','w').write(json.dumps({'name':'task-library'})); os.symlink(p+'/manifest-target',p+'/.agenc-plugin/plugin.json')\n" +
    "open(p+'/skills/example/SKILL.md','wb').write('\\ufefftask α\\r\\n'.encode()); open(p+'/commands/example.md','w').write('task command')\n" +
    "os.symlink(p+'/skills/example/SKILL.md',p+'/absolute'); os.mkfifo(p+'/fifo'); os.mkdir(p+'/race'); open(p+'/race/file','w').write('original')", [pluginRoot]);
  await mkdir(pluginRoot + "/.agenc-plugin", { recursive: true });
  await mkdir(pluginRoot + "/skills/example", { recursive: true });
  await writeFile(pluginRoot + "/.agenc-plugin/plugin.json", JSON.stringify({ name: "operator-library" }));
  await writeFile(pluginRoot + "/skills/example/SKILL.md", "controller skill");
  try {
    const options = { workspaceRoot, pluginStorageRoot, executionEnvironment: environment, readOnly: true,
      config: { plugins: { enabled: true } } };
    const plugins = await loadPlugins(options);
    assert.deepEqual(plugins.errors, []);
    assert.deepEqual(plugins.enabled.map((plugin) => plugin.id).sort(), ["operator-library", "task-library"]);
    const task = plugins.enabled.find((plugin) => plugin.id === "task-library")!;
    assert.deepEqual(task.executionBinding, environment.binding);
    assert.equal(task.contentProvenance, "repository-controlled");
    assert.deepEqual(task.commands.map((command) => command.path), [pluginRoot + "/commands/example.md"]);
    const roots = await discoverPluginSkillRootsWithProvenance(options);
    assert.equal(roots.length, 2);
    assert.equal(roots.filter((entry) => entry.executionBinding).length, 1);
    await python("import os,sys\np=sys.argv[1]; os.mkdir(p+'/agents'); open(p+'/agents/helper.md','w').write('Task helper guidance')", [pluginRoot]);
    const registered = await refreshPluginRegistrations(options);
    assert.deepEqual(registered.loadResult.errors, []);
    assert.equal(registered.commands.length, 1);
    const command = registered.commands[0];
    assert.equal(command.type, "prompt");
    if (command.type === "prompt") {
      assert.match(JSON.stringify(await command.getPromptForCommand!("", {})), /task command/);
      assert.deepEqual(command.executionBinding, environment.binding);
    }
    assert.equal(registered.agents[0].getSystemPrompt(), "Task helper guidance");
    assert.deepEqual(registered.agents[0].executionBinding, environment.binding);
    assert.equal(registered.agents[0].repositoryControlled, true);
    assert.equal(registered.skills.length, 2);
    const direct = (await loadPluginSkillDirectory(task, pluginRoot + "/skills/example", pluginStorageRoot, environment))[0];
    assert.equal(direct.type, "prompt");
    if (direct.type === "prompt") assert.match(JSON.stringify(await direct.getPromptForCommand!("", {})), /task α/);
    await python("import sys\nopen(sys.argv[1]+'/commands/example.md','w').write('changed task command')", [pluginRoot]);
    const refreshed = (await loadPluginCommands(options))[0];
    assert.equal(refreshed.type, "prompt");
    if (refreshed.type === "prompt") assert.match(JSON.stringify(await refreshed.getPromptForCommand!("", {})), /changed task command/);
    const filesystem = new ContentFilesystem(environment);
    assert.equal(await filesystem.readText(pluginRoot + "/absolute"), "\ufefftask α\r\n");
    await assert.rejects(filesystem.readText(pluginRoot + "/fifo"), { code: "unsupported_resource" });
    await assert.rejects(filesystem.readText("/proc/self/environ"), { code: "unsupported_resource" });

    const skillRoot = workspaceRoot + "/.agenc/skills";
    await python("import os,sys\np=sys.argv[1]; os.makedirs(p+'/task'); open(p+'/task/SKILL.md','w').write('Task skill guidance β'); os.symlink(p+'/task',p+'/alias')", [skillRoot]);
    await mkdir(skillRoot + "/task", { recursive: true });
    await writeFile(skillRoot + "/task/SKILL.md", "Host shadow must not load");
    const skillOptions = { ...options, agencHome: workspaceRoot + "/controller", executionHomePath: root,
      env: { HOME: workspaceRoot + "/controller" }, watcherPollIntervalMs: 30, watcherDebounceMs: 1,
      watcherRunConfigChangeHooks: false, watcherClearRuntimeCaches: false };
    const skillSnapshot = await loadLocalSkillsSnapshot(skillOptions);
    const taskSkills = skillSnapshot.skills.filter((skill) => skill.root === skillRoot);
    assert.equal(taskSkills.length, 1, "Absolute task symlink must deduplicate by protected identity");
    assert.deepEqual(taskSkills[0].executionBinding, environment.binding);
    const events: string[][] = [];
    const services = createLocalSkillsServices({ ...skillOptions,
      skillChangeEventSink: { notify: (event) => { events.push([...event.changedPaths]); } } });
    await services.skillsWatcher.start();
    try {
      const rendered = await services.skillsManager.renderSkill!({ name: taskSkills[0].name });
      assert.match(rendered!.content, /Task skill guidance β/);
      assert.doesNotMatch(rendered!.content, /Host shadow/);
      await python("import os,sys\np=sys.argv[1]; os.makedirs(p+'/late'); open(p+'/late/SKILL.md','w').write('Created inside task')", [skillRoot]);
      const deadline = Date.now() + 5_000;
      while (!events.some((paths) => paths.includes(skillRoot + "/late/SKILL.md")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.ok(events.some((paths) => paths.includes(skillRoot + "/late/SKILL.md")), "Protected task watcher must observe new skills");
      assert.match((await services.skillsManager.renderSkill!({ name: "late" }))!.content, /Created inside task/);
      await python("import sys\nopen(sys.argv[1]+'/late/SKILL.md','w').write('Fresh task content')", [skillRoot]);
      assert.match((await services.skillsManager.renderSkill!({ name: "late" }))!.content, /Fresh task content/);
    } finally { await services.skillsWatcher.stop(); }
    console.log("Real skills: shared protected shell/file view, host shadow exclusion, absolute symlink deduplication, fresh rendering and protected hot reload passed");

    const racedEnvironment = { binding: environment.binding, filesystem: {
      ...environment.filesystem,
      describePath: environment.filesystem.describePath.bind(environment.filesystem),
      bindFileSnapshot: async (path: string) => {
        await python("import os,sys\np=sys.argv[1]; os.rename(p,p+'-moved'); os.mkdir(p); open(p+'/file','w').write('replacement')", [pluginRoot + "/race"]);
        return environment.filesystem.bindFileSnapshot(path);
      },
    } };
    await assert.rejects(new ContentFilesystem(racedEnvironment).readText(pluginRoot + "/race/file"), { code: "path_conflict" });
    await python("import sys,json\np=sys.argv[1]; open(p+'/manifest-target','w').write(json.dumps({'name':'task-library','dependencies':['absent']}))", [pluginRoot]);
    const changed = await loadPlugins(options);
    assert.deepEqual(changed.enabled.map((plugin) => plugin.id), ["operator-library"]);
    assert.deepEqual(changed.disabled.map((plugin) => plugin.id), ["task-library"]);
    await python("import os,sys\np=sys.argv[1]; os.unlink(p+'/manifest-target'); os.symlink('/proc/self/environ',p+'/manifest-target')", [pluginRoot]);
    const special = await createPluginFromPath(pluginRoot, { source: "task", enabled: true, executionEnvironment: environment });
    assert.equal(special.plugin, null);
    assert.ok(special.errors.length > 0);
    console.log("Real plugin content/registration: task/controller path isolation, protected manifests and guidance, command/skill rendering, agent binding, refresh, absolute symlinks, special-resource rejection, parent swaps and dependency ownership passed");
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
}
