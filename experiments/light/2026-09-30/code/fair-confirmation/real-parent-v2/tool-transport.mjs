// Synthetic provider with one canonical shell call. Never delegates to fetch.
import fs from 'node:fs';
import { join } from 'node:path';
let calls = 0;
const callId = 'call_real_parent_probe';
const arm = process.env.LIGHT_PARENT_PROBE_ARM;
const root = process.env.LIGHT_PARENT_PROBE_ROOT;
if (!['light', 'pi'].includes(arm) || !root) throw new Error('Missing explicit probe contract');
function stream(output, events) {
  const response = { id: `resp_parent_${calls}`, object: 'response', status: 'in_progress', model: 'gpt-6-luna', output: [] };
  const all = [{ type: 'response.created', response }, ...events,
    { type: 'response.completed', response: { ...response, status: 'completed', output,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }];
  return new Response(all.map((e, sequence_number) => 'data: ' + JSON.stringify({ ...e, sequence_number }) + '\n\n').join(''),
    { headers: { 'Content-Type': 'text/event-stream' } });
}
export async function syntheticFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://api.openai.com') throw new Error('Unexpected synthetic origin');
  if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'gpt-6-luna', object: 'model', owned_by: 'openai' }] });
  if (url.pathname !== '/v1/responses') throw new Error('Unexpected synthetic route');
  const body = JSON.parse(init?.body ?? await input.clone().text());
  if (++calls > 2 || body.model !== 'gpt-6-luna' || body.reasoning?.effort !== 'low' || body.max_output_tokens !== 8192) {
    throw new Error('Unexpected synthetic request settings/count');
  }
  const name = arm === 'light' ? 'exec_command' : 'bash';
  const commandKey = arm === 'light' ? 'cmd' : 'command';
  if (calls === 1) {
    const schema = body.tools?.find(t => t.type === 'function' && t.name === name);
    if (schema?.parameters?.properties?.[commandKey]?.type !== 'string') throw new Error('Canonical shell schema absent');
    const command = `node ${JSON.stringify(join(root, 'tool-sentinel.mjs'))}`;
    const args = arm === 'light' ? { cmd: command, login: false, yield_time_ms: 10000, max_output_tokens: 2000 } : { command };
    const item = { type: 'function_call', id: 'fc_parent_probe', call_id: callId, name,
      arguments: JSON.stringify(args), status: 'completed' };
    return stream([item], [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item }]);
  }
  const outputs = body.input?.filter(t => t.type === 'function_call_output' && t.call_id === callId) ?? [];
  if (outputs.length !== 1 || !outputs[0].output.includes('REAL_PARENT_TOOL_SENTINEL')) throw new Error('Canonical tool result missing');
  const evidence = JSON.parse(fs.readFileSync(join(root, 'tool-result.json'), 'utf8'));
  if (evidence.has_send || evidence.connected || evidence.has_node_options || evidence.has_channel_fd) throw new Error('Tool inherited channel/preload');
  const part = { type: 'output_text', text: 'offline real parent probe complete', annotations: [] };
  const item = { type: 'message', id: 'msg_parent_probe', role: 'assistant', status: 'completed', content: [part] };
  return stream([item], [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: part.text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: part.text },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item }]);
}
