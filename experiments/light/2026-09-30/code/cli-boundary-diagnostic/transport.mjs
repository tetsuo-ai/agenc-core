// Offline diagnostic transport. Never delegates to native fetch.
import fs from 'node:fs';
const mark = (stage, extra = {}) => fs.appendFileSync(process.env.LIGHT_BOUNDARY_CAPTURE,
  JSON.stringify({ stage, pid: process.pid, monotonic_ns: process.hrtime.bigint().toString(), ...extra }) + '\n');
mark('preload');
process.once('exit', () => mark('process_exit'));
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== 'api.openai.com') throw new Error('Offline diagnostic: unexpected host');
  if (url.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'gpt-6-luna', object: 'model', owned_by: 'openai' }] });
  if (url.pathname !== '/v1/responses') throw new Error('Offline diagnostic: unexpected endpoint');
  const body = JSON.parse(init?.body ?? await input.clone().text());
  mark('request_received', { model: body.model, effort: body.reasoning?.effort,
    summary: body.reasoning?.summary, output_cap: body.max_output_tokens,
    replay_requested: body.include?.includes('reasoning.encrypted_content') === true });
  if (body.model !== 'gpt-6-luna' || body.reasoning?.effort !== 'low' || body.max_output_tokens !== 8192)
    throw new Error('Offline diagnostic: unequal request settings');
  const part = { type: 'output_text', text: 'boundary diagnostic complete', annotations: [] };
  const message = { id: 'msg_boundary', type: 'message', role: 'assistant', status: 'completed', content: [part] };
  const response = { id: 'resp_boundary', object: 'response', status: 'in_progress', model: 'gpt-6-luna', output: [] };
  const events = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: part.text },
    { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: part.text },
    { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [message],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  const raw = events.map((event, sequence_number) => 'data: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n').join('');
  const result = new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } });
  mark('response_constructed');
  return result;
};
