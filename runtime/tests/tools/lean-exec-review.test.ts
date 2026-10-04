// Reviewer regressions (rv, 2026-10-02): the lean exec_command needs a discovery fallback.
import {expect,test,vi} from "vitest";
import {buildToolRegistry} from "../../src/tool-registry.js";
import {bindExplicitDangerBoundary} from "../helpers/explicit-danger-boundary.js";
const fields=(registry:ReturnType<typeof buildToolRegistry>)=>Object.keys(registry.toLLMTools().find(t=>t.function.name==="exec_command")!.function.parameters.properties!).sort();
test.each([{select:"exec_command"},{query:"select:exec_command"}])("real searchTools selection loads every exec field (%j)",async args=>{
 const registry=buildToolRegistry({workspaceRoot:"/tmp",lightMode:true,requireAdmission:false});
 const sibling=buildToolRegistry({workspaceRoot:"/tmp",lightMode:true,requireAdmission:false});
 const siblingBefore=fields(sibling);
 const canonical=registry.tools.find(t=>t.name==="exec_command")!;
 const before=JSON.stringify(canonical.inputSchema);
 const result=await registry.dispatch({id:"rv-select",name:"system.searchTools",arguments:JSON.stringify(args)});
 expect(result.isError).not.toBe(true);
 expect(JSON.parse(result.content).loaded).toContain("exec_command");
 expect(fields(registry)).toEqual(Object.keys(canonical.inputSchema.properties!).sort());
 expect(JSON.stringify(canonical.inputSchema)).toBe(before);
 expect(fields(sibling)).toEqual(siblingBefore);
 expect(registry.getDiscoveredToolNames?.().has("exec_command")).toBe(true);
});
test.each([
 {toolsConfig:{disabled_tools:["system.searchTools"]}},
 {toolsConfig:{enabled_tools:["exec_command"]}},
 {unavailableCalledTools:["system.searchTools"]},
])("when policy removes discovery, permitted exec exposes all fields (%j)",async restriction=>{
 const registry=buildToolRegistry({workspaceRoot:"/tmp",lightMode:true,requireAdmission:false,...restriction});
 expect(registry.toLLMTools().some(t=>t.function.name==="system.searchTools")).toBe(false);
 expect((await registry.dispatch({id:"rv-unavailable-select",name:"system.searchTools",arguments:'{"select":"exec_command"}'})).isError).toBe(true);
 const canonical=registry.tools.find(t=>t.name==="exec_command")!;
 expect(fields(registry)).toEqual(Object.keys(canonical.inputSchema.properties!).sort());
});
test("advanced fields still execute before discovery through the canonical tool",async()=>{
 const execCommand=vi.fn(async()=>({output:"ok",stdout:"ok",stderr:"",exitCode:0,exit_code:0,durationMs:1,wall_time_seconds:.001,timedOut:false,truncated:false,original_token_count:1}));
 const registry=buildToolRegistry({workspaceRoot:"/tmp",lightMode:true,
  getSession:()=>({services:{runtimeOptions:{lightMode:true,nonInteractive:true,dangerouslyBypassApprovalsAndSandbox:true}}}) as never,
  unifiedExecManager:{maxTimeoutMs:30000,execCommand,writeStdin:vi.fn(),closeAll:vi.fn(async()=>{})} as never});
 const tool=bindExplicitDangerBoundary(registry.tools.find(t=>t.name==="exec_command")!);
 expect((await tool.execute({cmd:"pwd",timeoutMs:500,max_output_tokens:128,shell:"/bin/sh",login:false})).isError).not.toBe(true);
 expect(execCommand).toHaveBeenCalledWith(expect.objectContaining({cmd:"pwd",timeoutMs:500,max_output_tokens:128,shell:"/bin/sh",login:false}));
});
