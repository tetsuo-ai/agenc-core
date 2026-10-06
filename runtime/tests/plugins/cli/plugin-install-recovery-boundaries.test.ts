import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installPluginOp, updatePluginOp } from "../../../src/plugins/cli/pluginOperations.js";
import { recoverPluginInstallTransactions, PluginInstallTransactionSimulatedCrash } from "../../../src/plugins/cli/plugin-install-transaction.js";
import { applyCanonicalConfigPatchSync } from "../../../src/config/update-sync.js";

it.each(["destination-replaced", "config-published"] as const)("RV: fences a cooperative config edit before payload recovery at %s", async crashPhase => {
  const root = await mkdtemp(join(tmpdir(), "rv-plugin-recovery-"));
  try {
    const agencHome = join(root, "home"), workspaceRoot = join(root, "workspace");
    const pluginStorageRoot = join(agencHome, "plugins");
    await mkdir(pluginStorageRoot, {recursive:true});
    await mkdir(workspaceRoot, {recursive:true});
    const authority = {agencHome, workspaceRoot, pluginStorageRoot, sessionTempRoot:join(agencHome,"tmp"), env:Object.freeze({}) as NodeJS.ProcessEnv};
    async function source(version:string) {
      const p=join(root,"source-"+version);
      await mkdir(join(p,".agenc-plugin"),{recursive:true});
      await mkdir(join(p,"commands"),{recursive:true});
      await writeFile(join(p,".agenc-plugin","plugin.json"), JSON.stringify({name:"demo",version,commands:"./commands"}));
      await writeFile(join(p,"commands","hello.md"),"# Hello\n");
      return p;
    }
    const first=await installPluginOp({...authority,source:await source("1.0.0")});
    await expect(updatePluginOp({...authority,pluginId:"demo",source:await source("2.0.0"),installTransactionHooks:{afterPhase:async phase=>{
      if(phase===crashPhase) throw new PluginInstallTransactionSimulatedCrash(phase);
    }}})).rejects.toBeInstanceOf(PluginInstallTransactionSimulatedCrash);
    let attempted=false;
    const config=join(agencHome,"config.toml");
    const result=await recoverPluginInstallTransactions({installRoots:[pluginStorageRoot],userConfigPath:config,hooks:{beforeRemoveMatchedDirectory:async path=>{
      if(path!==first.destination)return;
      attempted=true;
      applyCanonicalConfigPatchSync(config,{plugins:{plugins:{demo:{enabled:false}}}},"user");
    }}});
    const actualVersion=JSON.parse(await readFile(join(first.destination,".agenc-plugin","plugin.json"),"utf8")).version;
    expect(attempted).toBe(true);
    expect(result.recovered).toBe(0);
    expect(result.issues.some(issue=>/reserved for install recovery/u.test(issue.message))).toBe(true);
    expect(actualVersion).toBe("2.0.0");
  } finally {await rm(root,{recursive:true,force:true});}
});

import { randomUUID } from "node:crypto";
import { preparePluginConfigTransaction, reservePluginConfigRollback, finishPluginConfigRollback } from "../../../src/plugins/plugin-config-transaction.js";
it("RV: prepared token without recorded snapshot survives restart after reservation", async () => {
  const root=await mkdtemp(join(tmpdir(),"rv-prepared-recovery-"));
  try {
    const config=join(root,"config.toml"),token=randomUUID();
    await writeFile(config,"config_version = 2\n[plugins]\nenabled = false\n");
    preparePluginConfigTransaction(config,"demo",token);
    // Process loss after header preparation, before snapshot record persistence.
    reservePluginConfigRollback(config,"demo",token,undefined);
    // A second recovery after process loss while rollback was reserved.
    expect(()=>reservePluginConfigRollback(config,"demo",token,undefined)).not.toThrow();
    finishPluginConfigRollback(config,"demo",token,undefined);
  } finally {await rm(root,{recursive:true,force:true});}
});
