import { describe, expect, test, vi } from "vitest";
import { createProvider, readProviderIdentity } from "../../../src/llm/provider.js";
import { resolveProviderCredentialAuthority } from "../../../src/llm/provider-options.js";
import { resolveProviderCapabilityEntry } from "../../../src/llm/capabilities.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { OLLAMA_CLOUD_MODELS } from "../../../src/llm/registry/ollama-cloud-models.js";
import {
 clearPublishedModelCatalogs,
 publishedModelDetailRecordedAt,
 recordPublishedModelCatalog,
 recordPublishedModelDetail,
} from "../../../src/llm/registry/published-model-catalog.js";
import { ModelMetadataResolver } from "../../../src/llm/model-metadata.js";
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
  // No Ollama Cloud model lists `minimal`: an unlisted level is never sent.
  await provider.chat([{role:"user",content:"hi"}],{reasoningEffort:"minimal"});
  expect(body(fetchImpl,fetchImpl.mock.calls.length-1).reasoning_effort).toBeUndefined();
 });

 test("uses the row the session already read instead of reading it again before the first request",async()=>{
  const ollamaRows=async(input:RequestInfo|URL)=>{
   const url=input instanceof Request?input.url:String(input);
   if(url.endsWith("/api/tags"))return Response.json({models:[{name:model,model,capabilities:["completion","tools","thinking","vision"]},{name:"glm-5.3",model:"glm-5.3",capabilities:["completion","tools","thinking"]}]});
   if(url.endsWith("/api/show"))return Response.json({capabilities:["completion","tools","thinking","vision"],model_info:{"deepseek.context_length":1048576},thinking:{values:["low","high","max"],default:"high"}});
   return reply();
  };
  const urls:string[]=[];
  const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async(input)=>{urls.push(input instanceof Request?input.url:String(input));return ollamaRows(input);});
  const metadata=()=>urls.filter(url=>url.startsWith("https://ollama.com/api/")).sort();
  const profile=(provider:unknown,options:object={})=>(provider as {getExecutionProfile:(o:object)=>Promise<unknown>}).getExecutionProfile(options);
  try{
   // The session's resolver reads the model's rows when the session starts.
   await new ModelMetadataResolver({fetchImpl:vi.fn<typeof fetch>().mockImplementation(ollamaRows),env:{OLLAMA_API_KEY:"fixture-key"}}).discoverOllamaCloudModels({},model);
   expect(publishedModelDetailRecordedAt("ollama-cloud",model)).toBeTypeOf("number");
   const provider=createProvider("ollama-cloud",{model,apiKey:"fixture-key",extra:{fetchImpl}});
   await profile(provider);
   await provider.chat([{role:"user",content:"hi"}]);
   expect(metadata()).toEqual([]);
   expect(urls).toEqual(["https://ollama.com/v1/chat/completions"]);
   // A model this process has not read yet is still read first.
   await profile(provider,{model:"glm-5.3"});
   expect(metadata()).toEqual(["https://ollama.com/api/show","https://ollama.com/api/tags"]);
   // So is a row read long ago.
   urls.length=0;
   recordPublishedModelDetail("ollama-cloud",model,Date.now()-16*60_000);
   await profile(createProvider("ollama-cloud",{model,apiKey:"fixture-key",extra:{fetchImpl}}));
   expect(metadata()).toEqual(["https://ollama.com/api/show","https://ollama.com/api/tags"]);
  }finally{clearPublishedModelCatalogs();}
 });

 test("a complete model list drops the marks of earlier per-model reads",()=>{
  try{
   recordPublishedModelDetail("ollama-cloud",model);
   recordPublishedModelCatalog("ollama-cloud",[],{});
   expect(publishedModelDetailRecordedAt("ollama-cloud",model)).toBeTypeOf("number");
   recordPublishedModelCatalog("ollama-cloud",[],{replace:true});
   expect(publishedModelDetailRecordedAt("ollama-cloud",model)).toBeUndefined();
   recordPublishedModelDetail("ollama-cloud",model);
   clearPublishedModelCatalogs();
   expect(publishedModelDetailRecordedAt("ollama-cloud",model)).toBeUndefined();
  }finally{clearPublishedModelCatalogs();}
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
  // A DeepSeek model gets DeepSeek's own prompt: no tool-name alias block, so no system message here.
  expect(messages.map((m:LLMMessage)=>m.role)).toEqual(["user","assistant","tool","user"]);
  expect(messages.find((m:LLMMessage)=>m.role==='assistant').reasoning).toBe("inspect the fixture");
  expect(JSON.stringify(messages.at(-1))).toContain(image);
 });

 test("keeps the tool-name alias block for models outside the DeepSeek family",async()=>{
  const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async()=>reply());
  const send=async(name:string)=>{
   const provider=createProvider("ollama-cloud",{model:name,apiKey:"fixture-key",tools:[tool],extra:{fetchImpl}});
   await provider.chat([{role:"user",content:"hi"}]);
   return body(fetchImpl,fetchImpl.mock.calls.length-1).messages as Array<{role:string;content:string}>;
  };
  const glm=await send("glm-5.3");
  expect(glm[0]?.role).toBe("system");
  expect(glm[0]?.content).toContain("Mapping (runtime name -> callable function name)");
  expect((await send("deepseek-v4-pro:0813")).some(m=>m.role==="system")).toBe(false);
 });

 // MiniMax models on Ollama Cloud stream parallel calls that all carry index 0
 // (live 2026-10-20, jobs/pv/live/ollama/oc-base-1/call-0004.response.raw).
 test("keeps parallel tool calls that share one stream index apart by id",async()=>{
  const sse=(chunks:unknown[])=>new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValueOnce(sse([
   {choices:[{index:0,delta:{content:"Reading both."}}]},
   {choices:[{index:0,delta:{tool_calls:[
    {id:"call_function_a_1",index:0,type:"function",function:{name:"mcp__fixture__read",arguments:'{"path":"a.txt"}'}},
    {id:"call_function_a_2",index:0,type:"function",function:{name:"mcp__fixture__read",arguments:'{"path":"b.txt"}'}},
   ]}}]},
   {choices:[{index:0,delta:{},finish_reason:"tool_calls"}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}},
  ]));
  const provider=createProvider("ollama-cloud",{model:"minimax-m3.1-flash",apiKey:"fixture-key",tools:[tool],extra:{fetchImpl}});
  const response=await provider.chatStream([{role:"user",content:"read a and b"}],()=>{});
  expect(response.toolCalls?.map(call=>[call.id,call.arguments])).toEqual([
   ["call_function_a_1",'{"path":"a.txt"}'],["call_function_a_2",'{"path":"b.txt"}'],
  ]);
 });

 // Live 2026-10-20: mistral-large-4 is listed but "being rolled out" (403) and
 // muse-spark-open can answer 451 by region. The key is fine; the model is not.
 test("reports a rollout or region gate as an unavailable model, not a bad key",async()=>{
  for(const [status,text] of [[403,"This model is currently being rolled out and is not yet available to you. Please check back later."],[451,"muse-spark-open is not available in your region"]] as const){
   const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({error:{message:text,type:"api_error"}}),{status,headers:{"content-type":"application/json"}}));
   const provider=createProvider("ollama-cloud",{model:"mistral-large-4",apiKey:"fixture-key",extra:{fetchImpl}});
   const error=await provider.chat([{role:"user",content:"hi"}]).then(()=>undefined,(caught:unknown)=>caught as Error);
   expect(error?.name).not.toBe("LLMAuthenticationError");
   expect(error?.message).toContain("openai_category=model_not_found");
   expect(error?.message).not.toMatch(/authentication failed/i);
  }
 });

 test("rejects direct images on text-only models before sending a request",async()=>{
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(reply());
  const provider=createProvider("ollama-cloud",{model:"gpt-oss:20b",apiKey:"fixture-key",extra:{fetchImpl}});
  await expect(provider.chat([{role:"user",content:[{type:"image_url",image_url:{url:image}}]}])).rejects.toThrow(/image input/);
  expect(fetchImpl).not.toHaveBeenCalled();
 });
});
