import assert from "node:assert/strict";
import { resolveExecutionPermissionPath } from "../../src/execution/permission-path.js";
import { DockerExecutionFilesystem } from "../../src/execution/docker-filesystem.js";
import type { ExecutionEnvironment } from "../../src/execution/types.js";

export async function permissionPathProbe(environment: ExecutionEnvironment, root: string,
  python: (source: string, args?: readonly string[]) => Promise<Buffer>): Promise<void> {
  const cwd = root + "/permission-path", filesystem = environment.filesystem as DockerExecutionFilesystem;
  await python("import os,sys\nr=sys.argv[1]\nos.makedirs(r+'/real/nested')\n" +
    "open(r+'/real/file','w').write('task notes')\n" +
    "os.symlink(r+'/real/nested',r+'/dir')\nos.symlink('dir/../file',r+'/link')\n" +
    "os.symlink(r+'/real/absent/new',r+'/dangling')\nos.symlink('loop',r+'/loop')\nos.mkfifo(r+'/fifo')", [cwd]);
  const result = await resolveExecutionPermissionPath(environment, "link", { cwd });
  assert.equal(result.canonicalPath, cwd + "/real/file");
  assert.ok(result.paths.includes(cwd + "/dir/../file"));
  assert.equal((await resolveExecutionPermissionPath(environment, "dangling", { cwd })).canonicalPath, cwd + "/real/absent/new");
  assert.equal((await resolveExecutionPermissionPath(environment, "dir/new", { cwd })).description, null);
  await assert.rejects(resolveExecutionPermissionPath(environment, "loop", { cwd }), { code: "unsupported_resource" });
  await assert.rejects(resolveExecutionPermissionPath(environment, "fifo", { cwd }), { code: "unsupported_resource" });
  const original = await filesystem.describePath(cwd + "/link", { followSymlinks: false });
  assert.equal(await filesystem.readLink(original), "dir/../file");
  const rpc = filesystem.rpc;
  let injected = false;
  filesystem.rpc = async function(operation, args = {}, onEffectStart) {
    if (operation === "readlink" && !injected) {
      injected = true;
      await python("import os,sys\np=sys.argv[1]\nos.unlink(p)\nos.symlink('/different',p)", [cwd + "/link"]);
    }
    return rpc.call(this, operation, args, onEffectStart);
  };
  try { await assert.rejects(filesystem.readLink(original), { code: "path_conflict" }); }
  finally { filesystem.rpc = rpc; }
  assert.ok(injected);
  console.log("Protected permission paths: task symlink chains, dangling targets, kernel dot-dot semantics, special-resource rejection and held-link replacement fencing passed");
}
