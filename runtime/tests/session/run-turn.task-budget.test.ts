import { expect, it } from "vitest";
import { runTurn } from "../../src/session/run-turn.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

it("warns once, finishes the last tool and persists a bounded final summary", async () => {
  let calls = 0;
  let finishedTools = 0;
  const requests: LLMMessage[][] = [];
  const provider = mkProvider();
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    expect(finishedTools).toBe(calls);
    requests.push([...messages]);
    calls++;
    return {content:"Checking the fix.",toolCalls:[{id:`call-${calls}`,name:"probe",arguments:"{}"}],
      usage:{promptTokens:10,completionTokens:1,totalTokens:11,availability:"reported",provenance:"provider"},model:"test-model",finishReason:"tool_calls"};
  };
  const registry = { tools:[{name:"probe",description:"check",inputSchema:{type:"object"},requiresApproval:false,
    recoveryCategory:"idempotent",execute:async () => { await Promise.resolve(); finishedTools++; return {content:"passed",isError:false}; }}],
    toLLMTools:()=>[],dispatch:async()=>({content:"",isError:false}) } as unknown as ToolRegistry;
  const {session,events} = mkSession({provider,registry});
  Object.assign(session.config,{taskMaxCalls:5});
  const phases: PhaseEvent[]=[];
  for await (const phase of runTurn(session,mkCtx(),"Fix and check")) phases.push(phase);
  expect(calls).toBe(5);
  expect(finishedTools).toBe(5);
  expect(JSON.stringify(requests[4])).toContain("decisive check");
  expect(JSON.stringify(requests.slice(0,4))).not.toContain("decisive check");
  expect(phases.at(-1)).toMatchObject({stopReason:"task_budget",content:expect.stringContaining("Partial result")});
  expect(events.filter(e=>e.msg.type==="turn_failed")).toHaveLength(1);
});

it.each(["stop", "length"] as const)("retains the last admitted answer when finishing with %s", async finishReason => {
  const content = "The first check passed; one remaining case needs investigation.";
  const provider = mkProvider();
  let calls = 0;
  provider.chatStream = async (): Promise<LLMResponse> => {
    calls++;
    return { content, toolCalls: [], model: "test-model", finishReason,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, availability: "reported", provenance: "provider" } };
  };
  const { session } = mkSession({ provider });
  Object.assign(session.config, { taskTokenBudget: 0, taskMaxCalls: 1 });
  const phases: PhaseEvent[] = [];
  for await (const phase of runTurn(session, mkCtx(), "Check and report")) phases.push(phase);
  expect(calls).toBe(1);
  expect(phases.at(-1)).toMatchObject({ content: expect.stringContaining(content) });
  if (finishReason === "length") expect(phases.at(-1)).toMatchObject({ stopReason: "task_budget" });
});


it("drains the final tool and summarizes when actual usage crosses the token cap", async () => {
  const provider = mkProvider(); let calls=0; let completed=false;
  provider.chatStream = async (): Promise<LLMResponse> => {
    calls++;
    return {content:"A check is running.",toolCalls:[{id:"last",name:"probe",arguments:"{}"}],model:"test-model",finishReason:"tool_calls",
      usage:{promptTokens:100000,completionTokens:1,totalTokens:100001,availability:"reported",provenance:"provider"}};
  };
  const registry = {tools:[{name:"probe",description:"check",inputSchema:{type:"object"},requiresApproval:false,recoveryCategory:"idempotent",execute:async()=>{await Promise.resolve();completed=true;return {content:"passed",isError:false};}}],toLLMTools:()=>[],dispatch:async()=>({content:"",isError:false})} as unknown as ToolRegistry;
  const {session}=mkSession({provider,registry});Object.assign(session.config,{taskTokenBudget:100000});
  const phases:PhaseEvent[]=[];
  for await(const phase of runTurn(session,mkCtx(),"Check")) phases.push(phase);
  expect(calls).toBe(1);expect(completed).toBe(true);
  expect(phases.at(-1)).toMatchObject({stopReason:"task_budget",content:expect.stringContaining("100001 tokens")});
});
