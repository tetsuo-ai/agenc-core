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
