// Synthetic CLI preflight only. Never forwards any network request.
import fs from 'node:fs';
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== 'api.openai.com') throw new Error('Synthetic startup: unexpected host');
  if (url.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'gpt-6-luna', object: 'model', owned_by: 'openai' }] });
  if (url.pathname !== '/v1/responses') throw new Error('Synthetic startup: unexpected endpoint');
  const body = JSON.parse(init?.body ?? await input.clone().text());
  const settings = { model: body.model, effort: body.reasoning?.effort, summary: body.reasoning?.summary,
    output_cap: body.max_output_tokens, include: body.include };
  fs.appendFileSync(process.env.LUNA_STARTUP_CAPTURE, JSON.stringify(settings) + '\n');
  if (settings.model !== 'gpt-6-luna' || settings.effort !== 'low' || settings.summary !== process.env.LUNA_STARTUP_SUMMARY
      || settings.output_cap !== 8192 || !settings.include?.includes('reasoning.encrypted_content')) {
    throw new Error('Synthetic startup: request settings mismatch');
  }
  const part = { type: 'output_text', text: 'startup validated', annotations: [] };
  const message = { id: 'msg_startup', type: 'message', role: 'assistant', status: 'completed', content: [part] };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: part.text },
    { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: part.text },
    { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'resp_startup', object: 'response', status: 'completed', model: 'gpt-6-luna',
      output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
  ];
  return new Response(events.map((event, sequence_number) => 'data: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n').join(''),
    { headers: { 'Content-Type': 'text/event-stream' } });
};
