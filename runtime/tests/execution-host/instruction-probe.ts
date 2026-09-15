import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { ExecutionEnvironment } from "../../src/execution/types.js";
import { readInstructionFileSnapshot, ExternalInstructionApprovalStore, type InstructionFileIdentity } from "../../src/prompts/secure-instruction-file.js";
import { loadProjectInstructions, loadProjectInstructionChain } from "../../src/prompts/project-instructions.js";
import { clearTieredInstructionsCacheForTesting, loadTieredInstructions, resolveIncludes } from "../../src/prompts/agenc-md.js";
import { discoverInstructionRulesDetailed, scanInstructionRulePaths } from "../../src/prompts/rules/discovery.js";

export async function instructionProbe(environment: ExecutionEnvironment, root: string,
  python: (source: string, args?: readonly string[]) => Promise<Buffer>): Promise<void> {
  const project = root + "/instructions";
  const main = project + "/AGENC.md";
  const outside = root + "/approved.md";
  await python("import os,sys\nr,o=sys.argv[1:]\nos.makedirs(r+'/nested'); os.mkdir(r+'/.git'); os.mkdir(r+'/.agenc'); os.mkdir(r+'/race')\n" +
    "open(r+'/AGENC.md','wb').write('\\ufefftask α\\r\\n'.encode())\n" +
    "os.utime(r+'/AGENC.md',ns=(10000000001234567890,10000000001234567890))\n" +
    "open(r+'/.agenc/AGENC.md','w').write('dot instructions')\n" +
    "open(r+'/nested/AGENC.override.md','w').write('nested override')\n" +
    "open(r+'/race/file','w').write('original')\n" +
    "open(r+'/linked','w').write('hard link'); os.link(r+'/linked',r+'/hard')\n" +
    "os.symlink(r+'/AGENC.md',r+'/absolute'); os.symlink(r+'/nested',r+'/linked-parent')\n" +
    "os.mkfifo(r+'/fifo'); open(r+'/invalid','wb').write(b'\\xff')\n" +
    "open(o,'w').write('approved outside guidance')", [project, outside]);
  // A real controller-side shadow must never become task guidance.
  await mkdir(project, { recursive: true });
  await writeFile(main, "host shadow instructions");
  try {
    const options = { requestedPath: main, boundaryRoot: project, workspaceRoot: project,
      sourceClass: "project" as const, maximumBytes: 100, executionEnvironment: environment };
    const read = await readInstructionFileSnapshot(options);
    assert.ok(read.ok, read.ok ? undefined : read.reason);
    assert.equal(read.snapshot.text, "task α\n");
    assert.deepEqual(read.snapshot.executionBinding, environment.binding);
    const actual = JSON.parse((await python("import os,sys,json\ns=os.stat(sys.argv[1]); print(json.dumps({k:str(getattr(s,'st_'+k)) for k in ['dev','ino','mode','nlink','size','mtime_ns','ctime_ns']}))", [main])).toString());
    assert.equal(read.snapshot.identity.mtimeNs.toString(), actual.mtime_ns);
    assert.equal(read.snapshot.identity.ctimeNs.toString(), actual.ctime_ns);
    assert.equal(read.snapshot.identity.nlink.toString(), actual.nlink);
    assert.equal((await environment.filesystem.describePath(project + "/absolute")).canonicalPath, main);
    assert.equal((await environment.filesystem.describePath(project + "/absolute", { followSymlinks: false })).canonicalPath, project + "/absolute");
    assert.equal((await environment.filesystem.describePath(project + "/nested/../.")).canonicalPath, project);
    assert.equal((await environment.filesystem.describePath("/../../")).canonicalPath, "/");
    for (const [name, reason] of [["absolute", "symlink"], ["linked-parent/AGENC.override.md", "symlink"],
      ["hard", "hard_link"], ["invalid", "invalid_utf8"], ["fifo", "read_error"], ["missing", "not_found"]]) {
      const result = await readInstructionFileSnapshot({ ...options, requestedPath: project + "/" + name });
      assert.equal(result.ok, false, name);
      if (!result.ok) assert.equal(result.reason, reason, name);
    }
    const tooLarge = await readInstructionFileSnapshot({ ...options, maximumBytes: 2 });
    assert.ok(!tooLarge.ok && tooLarge.reason === "too_large");
    const closest = await loadProjectInstructions({ cwd: project + "/nested", executionEnvironment: environment });
    assert.equal(closest?.content, "nested override");
    assert.equal(closest?.rootDir, project);
    const chain = await loadProjectInstructionChain({ cwd: project + "/nested", executionEnvironment: environment });
    assert.deepEqual(chain.map((entry) => entry.content), ["task α\n", "dot instructions", "nested override"]);
    assert.ok(chain.every((entry) => entry.executionBinding?.kind === "docker"));
    await python("import sys\nr=sys.argv[1]; open(r+'/include.md','w').write('@include nested/AGENC.override.md\\n@include ../approved.md\\n')", [project]);
    const expansion = await resolveIncludes("@include include.md", { baseDir: project, projectRoot: project,
      includingFile: main, includingFileSha256: read.snapshot.sha256, executionEnvironment: environment });
    assert.match(expansion.text, /nested override/);
    assert.doesNotMatch(expansion.text, /host shadow instructions|approved outside guidance/);
    assert.equal(expansion.dropped[0]?.reason, "approval_required");
    assert.ok(expansion.probes.every((probe) => probe.executionBinding?.kind === "docker"));

    await mkdir(project + "/rules");
    await writeFile(project + "/managed.md", "controller managed");
    await writeFile(project + "/rules/controller.md", "controller rule");
    await python("import os,sys\nr=sys.argv[1]; os.mkdir(r+'/.agenc/rules')\n" +
      "open(r+'/.agenc/rules/baseline.md','w').write('task rule')\n" +
      "open(r+'/.agenc/rules/conditional.md','w').write('---\\npaths: [nested]\\n---\\nconditional task rule')\n" +
      "open(r+'/AGENC.local.md','w').write('task local\\n@include nested/AGENC.override.md')", [project]);
    const tierOptions = { cwd: project + "/nested", configHomeDir: project, managedPath: project + "/managed.md",
      executionEnvironment: environment };
    const tiers = await loadTieredInstructions(tierOptions);
    assert.match(tiers.managed!.content, /controller managed/);
    assert.match(tiers.managed!.content, /controller rule/);
    assert.match(tiers.user!.content, /host shadow instructions/);
    assert.match(tiers.project!.content, /task α/);
    assert.match(tiers.project!.content, /task rule/);
    assert.doesNotMatch(tiers.project!.content, /conditional task rule|host shadow|controller/);
    assert.match(tiers.local!.content, /task local/);
    assert.match(tiers.local!.content, /nested override/);
    assert.deepEqual(tiers.project!.executionBinding, environment.binding);
    assert.equal(await loadTieredInstructions(tierOptions), tiers);
    const conditional = await discoverInstructionRulesDetailed({ rulesDir: project + "/.agenc/rules", boundaryDir: project,
      type: "Project", targetPath: project + "/nested/file.ts", includeUnconditional: false, executionEnvironment: environment });
    assert.deepEqual(conditional.rules.map((rule) => rule.content), ["conditional task rule"]);
    assert.deepEqual(conditional.rules[0].executionBinding, environment.binding);
    await python("import sys\nr=sys.argv[1]; open(r+'/.agenc/rules/baseline.md','w').write('changed task rule'); open(r+'/AGENC.override.md','w').write('preferred task guidance')", [project]);
    const changedTiers = await loadTieredInstructions(tierOptions);
    assert.match(changedTiers.project!.content, /changed task rule/);
    assert.match(changedTiers.project!.content, /preferred task guidance/);
    assert.doesNotMatch(changedTiers.project!.content, /task α/);
    await writeFile(main, "updated host user guidance");
    assert.match((await loadTieredInstructions(tierOptions)).user!.content, /updated host user guidance/);
    await python("import os,sys\nr=sys.argv[1]; os.mkdir(r+'/oversized-rules')\nfor i in range(2500): open(r+'/oversized-rules/'+str(i),'w').close()", [project]);
    const scan = await scanInstructionRulePaths({ executionEnvironment: environment,
      rulesDir: project + "/oversized-rules", boundaryDir: project });
    assert.equal(scan.overflowed, true);
    assert.deepEqual(scan.paths, []);
    console.log("Real task tiered instructions/rules: controller authority split, held directory cursors, conditional matching, negative/include/rule cache evidence and oversized tree rejection passed");

    const description = await environment.filesystem.describePath(outside);
    const targetIdentity = Object.fromEntries(Object.entries(description.identity).map(([key, value]) => [key, BigInt(value)])) as unknown as InstructionFileIdentity;
    const approvals = new ExternalInstructionApprovalStore();
    const approvalRequest = { workspaceRoot: project, includingSource: main, includingSourceSha256: read.snapshot.sha256,
      targetCanonicalPath: outside, targetIdentity, principal: "fixture-operator" };
    const includeOptions = { ...options, requestedPath: outside, includedBy: main, includedBySha256: read.snapshot.sha256,
      sourceClass: "include" as const, externalApprovals: approvals };
    approvals.grant(approvalRequest); // A host approval for equal paths does not authorize this task.
    const localApproval = await readInstructionFileSnapshot(includeOptions);
    assert.ok(!localApproval.ok && localApproval.reason === "approval_required");
    const approved = approvals.grant({ ...approvalRequest, executionBinding: environment.binding });
    const included = await readInstructionFileSnapshot(includeOptions);
    assert.ok(included.ok);
    assert.equal(included.snapshot.text, "approved outside guidance");
    const revoked = await readInstructionFileSnapshot({ ...includeOptions, beforeReadForTesting: () => { approvals.revoke(approved.id); } });
    assert.ok(!revoked.ok && revoked.reason === "approval_required");

    const replaced = await readInstructionFileSnapshot({ ...options, requestedPath: project + "/race/file",
      beforeOpenForTesting: async () => { await python("import os,sys\np=sys.argv[1]; os.rename(p,p+'-moved'); os.mkdir(p); open(p+'/file','w').write('replacement')", [project + "/race"]); } });
    assert.ok(!replaced.ok && replaced.reason === "unstable");
    const changed = await readInstructionFileSnapshot({ ...options, beforeReadForTesting: async () => {
      await python("import sys; open(sys.argv[1],'w').write('changed inode')", [main]);
    } });
    assert.ok(!changed.ok && changed.reason === "unstable");

    // Descriptor-relative walking retains paths beyond the kernel getcwd cap.
    const component = "d".repeat(48);
    const deep = project + "/" + Array(90).fill(component).join("/");
    await python("import os,sys\nos.chdir(sys.argv[1])\nfor _ in range(90): os.mkdir(sys.argv[2]); os.chdir(sys.argv[2])\nopen('file','w').write('deep')", [project, component]);
    assert.ok(deep.length > 4096);
    assert.equal((await environment.filesystem.describePath(deep + "/file")).canonicalPath, deep + "/file");
    const deepFile = await environment.filesystem.bindFileSnapshot(deep + "/file");
    try { assert.equal((await deepFile.describe()).canonicalPath, deep + "/file"); assert.equal((await deepFile.readFile(10)).toString(), "deep"); }
    finally { await deepFile.dispose(); }
    console.log("Real protected instruction loading: canonical task paths, exact metadata, host shadows, root/chain discovery, symlink/hard-link rejection, scoped external approval/revocation, races and >4096-byte paths passed");
  } finally { clearTieredInstructionsCacheForTesting(); await rm(project, { recursive: true, force: true }); }
}
