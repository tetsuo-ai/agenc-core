import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLayeredConfig } from "../../src/config/repository.js";
import { ExecutionConfigFilesystem } from "../../src/config/workspace-filesystem.js";
import type { ExecutionEnvironment } from "../../src/execution/types.js";

/** Real repository loader, controller-owned settings, and protected task I/O. */
export async function configProbe(environment: ExecutionEnvironment, root: string,
  python: (source: string, args?: readonly string[]) => Promise<Buffer>): Promise<void> {
  const home = await mkdtemp("/controller/config-home-");
  const project = root + "/configuration";
  const userConfig = join(home, "config.toml");
  try {
    await mkdir(project + "/.agenc", { recursive: true });
    await writeFile(userConfig, 'config_version = 2\nmodel = "controller-model"\n', { mode: 0o600 });
    await writeFile(project + "/.agenc/config.toml", 'config_version = 2\nmodel = "host-shadow"\n');
    await writeFile(project + "/.agenc/settings.json", "retired host shadow");
    await python("import os,sys\nr,h=sys.argv[1:]\nos.makedirs(r+'/.agenc'); os.makedirs(r+'/nested'); os.makedirs(h)\n" +
      "open(r+'/package.json','w').write('{}')\n" +
      "open(r+'/shared.toml','w').write('config_version = 2\\nmodel = \"task-model\"\\n')\n" +
      "os.symlink(r+'/shared.toml',r+'/.agenc/config.toml')\n" +
      "open(h+'/config.toml','w').write('config_version = 2\\nmodel = \"task-flag\"\\n')", [project, home]);
    const workspaceFilesystem = new ExecutionConfigFilesystem(environment, { homePath: "/root" });
    assert.equal((await workspaceFilesystem.readStableFile(project + "/.agenc/config.toml", { allowLeafSymlink: true }))?.resolvedPath, project + "/shared.toml");
    const options = { cwd: project + "/nested", env: { AGENC_HOME: home, HOME: "/controller" },
      managedConfigPath: join(home, "managed.toml"), managedDropInDir: join(home, "managed.d"), workspaceFilesystem };
    const untrusted = await loadLayeredConfig(options);
    assert.equal(untrusted.config.model, "controller-model");
    assert.ok(untrusted.ignored.some((value) => value.scope === "project" && value.key === "model" && value.reason.includes("trusted")));
    const loaded = await loadLayeredConfig({ ...options, projectTrusted: true });
    assert.equal(loaded.projectRoot, project);
    assert.equal(loaded.config.model, "task-model");
    assert.equal(loaded.sources.find((source) => source.scope === "user")?.config.model, "controller-model");
    assert.equal((await loadLayeredConfig({ ...options, flagConfigPath: userConfig })).config.model, "task-flag");
    await assert.rejects(loadLayeredConfig({ ...options, flagConfigPath: "../shared.toml" }), { code: "invalid-source" });
    await assert.rejects(workspaceFilesystem.readStableFile(project + "/.agenc/config.toml"), { code: "symbolic-link" });
    await python("import sys; open(sys.argv[1]+'/.mcp.json','w').write('retired task metadata')", [project]);
    await assert.rejects(loadLayeredConfig(options), { code: "retired-input" });
    assert.equal((await environment.filesystem.readFile(project + "/.mcp.json", 100)).toString(), "retired task metadata");
    console.log("Real layered config uses protected task files and task root discovery; controller settings, equal-path namespaces, absolute symlinks and retired-input authority pass");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}
