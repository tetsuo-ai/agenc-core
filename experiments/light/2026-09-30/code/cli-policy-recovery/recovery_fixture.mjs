// Offline synthetic transport. No native fetch, forwarding, credentials or ledger.
import fs from 'node:fs';

export const CALL_ID = 'call_policy_validation';
export const SENTINEL = 'LUNA_POLICY_VALIDATION_SENTINEL';
export const COMMAND = 'python3 -m unittest -q test_policy_failure.py';
const known = (value, values) => values.includes(value) ? value : 'invalid';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } };

function stream(output, events, index) {
  events.push({ type: 'response.completed', response: {
    id: `resp_policy_${index}`, object: 'response', status: 'completed',
    model: 'gpt-6-luna', output, usage,
  } });
  return new Response(events.map((event, sequence_number) =>
    'data: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n').join(''),
  { headers: { 'Content-Type': 'text/event-stream' } });
}

export function createRecoveryFetch({ capture, validationRan }) {
  let calls = 0;
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:' || url.hostname !== 'api.openai.com' || url.port) {
      throw new Error('Offline recovery fixture: unexpected origin');
    }
    if (url.pathname === '/v1/models') {
      return Response.json({ object: 'list', data: [{ id: 'gpt-6-luna', object: 'model', owned_by: 'openai' }] });
    }
    if (url.pathname !== '/v1/responses' || (init?.method ?? input.method ?? 'GET') !== 'POST') {
      throw new Error('Offline recovery fixture: unexpected endpoint or method');
    }
    const body = JSON.parse(init?.body ?? await input.clone().text());
    calls += 1;
    const tool = body.tools?.find(item => item.type === 'function' && item.name === 'exec_command');
    const results = Array.isArray(body.input) ? body.input.filter(item =>
      item.type === 'function_call_output' && item.call_id === CALL_ID) : [];
    const output = results.length === 1 && typeof results[0].output === 'string' ? results[0].output : '';
    const metadata = {
      request: calls,
      model_match: body.model === 'gpt-6-luna',
      effort: known(body.reasoning?.effort, ['none','minimal','low','medium','high','xhigh','max','ultra']),
      summary: known(body.reasoning?.summary, ['auto','concise','detailed','none']),
      output_cap: typeof body.max_output_tokens === 'number' && Number.isFinite(body.max_output_tokens) ? body.max_output_tokens : null,
      stream: body.stream === true,
      replay_requested: Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content'),
      canonical_exec_schema: tool?.parameters?.properties?.cmd?.type === 'string'
        && tool?.parameters?.required?.includes('cmd') === true,
      matching_tool_results: results.length,
      validation_failure_marker: output.includes(SENTINEL) && /FAILED\s*\(failures=1\)/.test(output),
      tool_exit_one: /(?:^|\s)exit_code=1(?:\s|\])/.test(output),
      validation_process_ran: validationRan(),
    };
    // Strict scalar allowlist: never capture prompts, arguments, raw output or headers.
    capture(metadata);
    if (!metadata.model_match || !metadata.stream || metadata.output_cap !== 8192
        || metadata.summary !== 'auto' || !metadata.replay_requested || calls > 2) {
      throw new Error('Offline recovery fixture: request contract mismatch');
    }
    if (calls === 1) {
      if (!metadata.canonical_exec_schema || metadata.matching_tool_results !== 0 || metadata.validation_process_ran) {
        throw new Error('Offline recovery fixture: invalid initial state');
      }
      const item = { type: 'function_call', id: 'fc_policy_validation', call_id: CALL_ID,
        name: 'exec_command', arguments: JSON.stringify({ cmd: COMMAND, yield_time_ms: 10000,
          max_output_tokens: 2000, login: false }), status: 'completed' };
      return stream([item], [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
        { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
        { type: 'response.output_item.done', output_index: 0, item },
      ], calls);
    }
    if (metadata.matching_tool_results !== 1 || !metadata.validation_failure_marker
        || !metadata.tool_exit_one || !metadata.validation_process_ran) {
      throw new Error('Offline recovery fixture: actual failed validation was not observed');
    }
    // Do not enforce effort here: the test must inspect the actual second wire
    // value even on the historically broken unconditional-low-to-medium source.
    const part = { type: 'output_text', text: 'offline recovery validated', annotations: [] };
    const item = { type: 'message', id: 'msg_policy_done', role: 'assistant', status: 'completed', content: [part] };
    return stream([item], [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: part.text },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: part.text },
      { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part },
      { type: 'response.output_item.done', output_index: 0, item },
    ], calls);
  };
}

if (process.env.LUNA_POLICY_CAPTURE) {
  const marker = process.env.LUNA_POLICY_MARKER;
  if (!marker) throw new Error('Offline recovery fixture: marker path required');
  globalThis.fetch = createRecoveryFetch({
    capture: record => fs.appendFileSync(process.env.LUNA_POLICY_CAPTURE, JSON.stringify(record) + '\n'),
    validationRan: () => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === SENTINEL,
  });
}
