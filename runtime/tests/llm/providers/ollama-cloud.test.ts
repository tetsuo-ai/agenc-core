import { describe, expect, test, vi } from "vitest";
import { createProvider, readProviderIdentity } from "../../../src/llm/provider.js";
import { resolveProviderCredentialAuthority } from "../../../src/llm/provider-options.js";
import { resolveProviderCapabilityEntry } from "../../../src/llm/capabilities.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { OLLAMA_CLOUD_MODELS } from "../../../src/llm/registry/ollama-cloud-models.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import type { LLMTool, LLMMessage } from "../../../src/llm/types.js";

const model="deepseek-v4.1-flash";
const tool:LLMTool={type:"function",function:{name:"mcp.fixture.read",description:"Read a fixture",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}};
const image="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const reply=(extra:Record<string,unknown>={})=>Response.json({id:"chat_1",model,choices:[{finish_reason:"stop",message:{role:"assistant",content:"done",...extra}}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}});
const body=(mock:ReturnType<typeof vi.fn<typeof fetch>>,i=0)=>JSON.parse(String(mock.mock.calls[i]?.[1]?.body));

describe("direct Ollama Cloud provider",()=>{
 test("keeps credentials and routing separate from local Ollama and OpenAI",async()=>{
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(reply());
  const provider=createProvider("ollama-cloud",{apiKey:"fixture-key",extra:{fetchImpl}});
  expect(readProviderIdentity(provider)).toBe("ollama-cloud");
  await provider.chat([{role:"user",content:"hi"}],{reasoningEffort:"low",maxOutputTokens:512});
  expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://ollama.com/v1/chat/completions");
  expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer fixture-key");
  expect(body(fetchImpl)).toMatchObject({model,max_tokens:512,reasoning_effort:"low"});
  expect(body(fetchImpl).max_completion_tokens).toBeUndefined();
  expect(()=>createProvider("ollama-cloud",{})).toThrow(/apiKey/i);
  for(const baseURL of ["http://ollama.com/v1","http://localhost:11434","https://wrong.invalid/v1"]){
   expect(()=>createProvider("ollama-cloud",{apiKey:"fixture-key",baseURL})).toThrow(/Ollama Cloud requires/);
  }
  const auth=resolveProviderCredentialAuthority("ollama-cloud",{model},{OLLAMA_API_KEY:"right",OPENAI_API_KEY:"wrong",OLLAMA_BASE_URL:"http://localhost:11434"});
  expect(auth.factoryOptions).toMatchObject({apiKey:"right"});
 });

 test.each(OLLAMA_CLOUD_MODELS)("registers the actual $model capabilities and effort wire",async entry=>{
  const catalog=resolveRegisteredModelCatalogEntry({provider:"ollama-cloud",model:entry.model});
  expect(catalog?.contextWindow).toBe(entry.contextWindow);
  expect(catalog?.supportsToolUse).toBe(true);
  const caps=resolveProviderCapabilityEntry({provider:"ollama-cloud",model:entry.model});
  expect(caps.supportsImageInput).toBe(entry.vision);expect(caps.supportsToolUse).toBe(true);
  const hints=chatCompletionsCapabilityHintsForProvider("ollama-cloud",entry.model);
  expect(hints.outputTokensCeiling).toBeUndefined();expect(hints.requiresGrammarSafeToolSchemas).toBe(false);
  const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async()=>reply());
  const provider=createProvider("ollama-cloud",{model:entry.model,apiKey:"fixture-key",tools:[tool],extra:{fetchImpl}});
  for(const effort of entry.efforts){
   await provider.chat([{role:"user",content:"hi"}],{reasoningEffort:effort});
   const request=body(fetchImpl,fetchImpl.mock.calls.length-1);
   expect(request.reasoning_effort).toBe(effort);expect(request.tools).toHaveLength(1);
  }
  await provider.chat([{role:"user",content:"hi"}],{reasoningEffort:"xhigh"});
  expect(body(fetchImpl,fetchImpl.mock.calls.length-1).reasoning_effort).toBeUndefined();
 });

 test("preserves streamed tool calls, usage and thinking for continuation",async()=>{
  const chunks=[
   {choices:[{index:0,delta:{reasoning:"inspect the fixture"}}]},
   {choices:[{index:0,delta:{tool_calls:[{index:0,id:"call_1",type:"function",function:{name:"mcp__fixture__read",arguments:'{"path":'}}]}}]},
   {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"image.png"}'}}]}}]},
   {choices:[{index:0,delta:{},finish_reason:"tool_calls"}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}},
  ];
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})).mockResolvedValueOnce(reply());
  const provider=createProvider("ollama-cloud",{model,apiKey:"fixture-key",tools:[tool],extra:{fetchImpl}});
  const response=await provider.chatStream([{role:"user",content:"inspect"}],()=>{},{reasoningEffort:"high"});
  expect(response.toolCalls).toHaveLength(1);expect(response.toolCalls?.[0]).toMatchObject({id:"call_1",name:tool.function.name,arguments:'{"path":"image.png"}'});
  expect(response.providerReasoningContent).toBe("inspect the fixture");
  expect(response.usage?.promptTokens).toBe(5);
  const history:LLMMessage[]=[{role:"user",content:"inspect"},{role:"assistant",content:"",toolCalls:response.toolCalls,providerReasoningContent:response.providerReasoningContent,providerReasoningProvenance:response.providerReasoningProvenance},{role:"tool",toolCallId:"call_1",toolName:tool.function.name,content:[{type:"text",text:"fixture image"},{type:"image_url",image_url:{url:image}}]}];
  await provider.chat(history,{reasoningEffort:"high"});
  const messages=body(fetchImpl,1).messages;
  expect(messages.map((m:LLMMessage)=>m.role)).toEqual(["system","user","assistant","tool","user"]);
  expect(messages.find((m:LLMMessage)=>m.role==='assistant').reasoning).toBe("inspect the fixture");
  expect(JSON.stringify(messages.at(-1))).toContain(image);
 });

 test("rejects direct images on text-only models before sending a request",async()=>{
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(reply());
  const provider=createProvider("ollama-cloud",{model:"gpt-oss:20b",apiKey:"fixture-key",extra:{fetchImpl}});
  await expect(provider.chat([{role:"user",content:[{type:"image_url",image_url:{url:image}}]}])).rejects.toThrow(/image input/);
  expect(fetchImpl).not.toHaveBeenCalled();
 });
});
