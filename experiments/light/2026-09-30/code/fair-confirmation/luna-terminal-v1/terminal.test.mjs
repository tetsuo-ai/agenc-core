import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createResponsesTerminal, DEPENDENCIES, LIMITS } from './terminal.mjs';

const options = { httpStatus: 200, contentType: 'text/event-stream', expectedModel: 'gpt-6-luna' };
const usage = () => ({ input_tokens: 100, output_tokens: 20, total_tokens: 120,
  input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } });
const response = (status, extra = {}) => ({ id: 'resp_synthetic', object: 'response', status,
  model: 'gpt-6-luna', error: null, incomplete_details: null, ...extra });
const created = () => ({ type: 'response.created', response: response('in_progress') });
const completed = (u = usage()) => ({ type: 'response.completed', response: response('completed', { usage: u }) });
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const bytes = text => new TextEncoder().encode(text);
const valid = () => frame(created()) + frame(completed());
function run(text, outcome = 'eof', opts = options) {
  const state = createResponsesTerminal(opts);
  state.push(typeof text === 'string' ? bytes(text) : text);
  return state.finish(outcome);
}
function unknown(value, reason) {
  assert.equal(value.state, 'unknown');
  assert.deepEqual(Object.keys(value).sort(), ['reason', 'state']);
  if (reason) assert.equal(value.reason, reason);
  assert.equal(Object.isFrozen(value), true);
}
function rawUsage(body) {
  return frame(created()) + 'data: {"type":"response.completed","response":'
    + JSON.stringify(response('completed')).slice(0, -1) + ',"usage":' + body + '}}\n\n';
}

test('frozen finance dependencies match the reviewed direct imports', () => {
  for (const [key, name] of [['accounting', 'accounting'], ['ledgerJson', 'ledger-json']]) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../luna-finance-v1/${name}.mjs`, import.meta.url))).digest('hex'), DEPENDENCIES[key]);
  }
});
test('completed full usage remains unknown until clean EOF; historical charge is exact', () => {
  const state = createResponsesTerminal(options);
  unknown(state.push(bytes(valid())), 'awaiting_eof');
  const result = state.finish('eof');
  assert.deepEqual(result, { state: 'known', proof: 'completed-full-usage-clean-eof-v1',
    responseIdSha256: createHash('sha256').update('resp_synthetic').digest('hex'),
    input: 100, output: 20, cached: 10, chargeNanos: '19100', priceId: 'historical-luna-fixture-nanodollars-v1' });
  assert.equal(Object.isFrozen(result), true);
});
test('genuine reported zero is known, unlike missing counters', () => {
  const zero = { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } };
  assert.equal(run(frame(created()) + frame(completed(zero))).chargeNanos, '0');
  for (const key of Object.keys(zero)) {
    const u = { ...zero }; delete u[key];
    unknown(run(frame(created()) + frame(completed(u))));
  }
  const end = completed(); delete end.response.usage;
  unknown(run(frame(created()) + frame(end)));
});
test('every byte boundary, including Unicode and CRLF, preserves exact result', () => {
  const text = (frame(created()) + frame({ type: 'response.output_text.delta', delta: '🦉 café' }) + frame(completed())).replaceAll('\n', '\r\n');
  const input = bytes(text), expected = run(input);
  for (let split = 0; split <= input.length; split++) {
    const state = createResponsesTerminal(options);
    state.push(input.subarray(0, split)); state.push(input.subarray(split));
    assert.deepEqual(state.finish('eof'), expected);
  }
  const state = createResponsesTerminal(options);
  for (const byte of input) state.push(new Uint8Array([byte]));
  assert.deepEqual(state.finish('eof'), expected);
});
test('final buffered frame, bare CR, optional DONE, comments and exact event fields', () => {
  for (const text of [valid().trimEnd(), valid().replaceAll('\n', '\r'), valid() + 'data: [DONE]',
    ': safe comment\n\n' + valid() + ': safe tail',
    'event: response.created\n' + frame(created()) + 'event: response.completed\n' + frame(completed())]) {
    assert.equal(run(text).state, 'known');
  }
});
test('multi-line JSON whitespace is supported without repairing invalid strings or whitespace', () => {
  const json = JSON.stringify(completed()).replace(',"response"', ',\n"response"');
  assert.equal(run(frame(created()) + json.split('\n').map(line => 'data: ' + line).join('\n') + '\n\n').state, 'known');
  for (const payload of ['{"type":"response.\ncompleted"}', '{\u00a0"type":"response.completed"}',
    '{\v"type":"response.completed"}', '{"type":"response.completed","x":"bad\rtext"}']) {
    unknown(run(frame(created()) + payload.split('\n').map(line => 'data: ' + line).join('\n') + '\n\n'));
  }
});
test('malformed UTF8, BOM, and truncated final code points stay unknown', () => {
  for (const input of [new Uint8Array([255]), bytes('\ufeff' + valid()),
    new Uint8Array([...bytes(valid()), 0xc3]), new Uint8Array([...bytes(valid()), 0xc3, 0x28])]) unknown(run(input), 'invalid_utf8');
});
test('duplicate keys, escaped duplicate keys, surrogate strings and malformed JSON reject', () => {
  for (const body of ['{"type":"response.completed","type":"response.completed"}',
    '{"type":"response.completed","t\\u0079pe":"response.completed"}',
    '{"type":"response.completed","x":"\\ud800"}', '{"type":"response.completed","\\udfff":1}',
    '{"type":"response.completed",}', '{"type":NaN}', '{"type":Infinity}',
    '{"type":"response.completed"', '[1]', 'null']) unknown(run(frame(created()) + 'data: ' + body));
});
test('token lexemes cannot round unsafe or fractional counts into accepted integers', () => {
  for (const raw of ['1.00000000000000001', '0.00000000000000000001', '9007199254740993',
    '1e309', '-0', '-1', 'true', 'null', '"1"', '{}', '[]']) {
    unknown(run(rawUsage(`{"input_tokens":${raw},"output_tokens":0,"total_tokens":1,"input_tokens_details":{"cached_tokens":0}}`)));
  }
  const exact = '{"input_tokens":1e2,"output_tokens":2e1,"total_tokens":120.0,"input_tokens_details":{"cached_tokens":1e1}}';
  assert.equal(run(rawUsage(exact)).chargeNanos, '19100');
});
test('numeric detail boxes never masquerade as objects', () => {
  for (const key of ['input_tokens_details', 'output_tokens_details']) {
    for (const raw of ['0', '1', '1.00000000000000001', 'null', '[]', 'true']) {
      const u = usage(); delete u[key];
      unknown(run(rawUsage(JSON.stringify(u).slice(0, -1) + `,"${key}":${raw}}`)));
    }
  }
});
test('cached, total and reasoning consistency cannot be bypassed', () => {
  for (const mutate of [u => { u.total_tokens++; }, u => { u.input_tokens_details.cached_tokens = 101; },
    u => { u.output_tokens_details.reasoning_tokens = 21; }, u => { u.output_tokens = null; },
    u => { delete u.input_tokens_details.cached_tokens; }]) {
    const u = usage(); mutate(u); unknown(run(frame(created()) + frame(completed(u))));
  }
});
test('read failure, cancellation, HTTP/nonstream or unsupported finish never release usage', () => {
  for (const outcome of ['read_error', 'cancelled', 'http_error', 'nonstream', undefined, null]) {
    const state = createResponsesTerminal(options); state.push(bytes(valid()));
    unknown(state.finish(outcome), 'unclean_transport');
  }
  for (const opts of [{ ...options, httpStatus: 201 }, { ...options, contentType: null },
    { ...options, contentType: 'application/json' }, { ...options, expectedModel: 'another' }, {}]) unknown(run(valid(), 'eof', opts), 'unsupported_transport');
});
test('interim usage is never a terminal proof', () => {
  const start = created(); start.response.usage = usage();
  unknown(run(frame(start)), 'missing_terminal');
  unknown(run(''), 'missing_terminal');
  unknown(run(frame(completed())), 'missing_created');
});
test('Content-Type accepts only ASCII SP/HTAB around its optional semicolon', () => {
  for (const contentType of ['text/event-stream', 'TEXT/EVENT-STREAM; CHARSET=UTF-8',
    'text/event-stream \t;\t charset=utf-8']) {
    assert.equal(run(valid(), 'eof', { ...options, contentType }).state, 'known');
  }
  for (const forbidden of ['\n', '\r', '\r\n', '\v', '\f', '\u00a0', '\u2028', '\u2029', '\0']) {
    for (const contentType of [`text/event-stream${forbidden}; charset=utf-8`,
      `text/event-stream;${forbidden}charset=utf-8`, `text/event-stream${forbidden}`,
      `text/event-stream; charset=utf-8${forbidden}`]) {
      unknown(run(valid(), 'eof', { ...options, contentType }), 'unsupported_transport');
    }
  }
});
for (const type of ['error', 'response.failed', 'response.incomplete', 'response.cancelled']) {
  test(`${type} is sticky before/after completed, even with full usage`, () => {
    const bad = { type, response: response('incomplete', { usage: usage() }), message: 'synthetic private payload' };
    for (const text of [frame(created()) + frame(bad) + frame(completed()), valid() + frame(bad)]) unknown(run(text), 'unsuccessful_terminal');
  });
}
test('duplicate or conflicting identities/terminal statuses stay unknown', () => {
  for (const text of [frame(created()) + valid(), valid() + frame(completed()),
    frame(created()) + frame({ ...completed(), response: { ...completed().response, id: 'resp_other' } }),
    frame(created()) + frame({ type: 'response.output_text.delta', response_id: 'resp_other', delta: 'x' }),
    frame(created()) + frame({ ...completed(), response: { ...completed().response, status: 'failed' } }),
    frame(created()) + frame({ ...completed(), response: { ...completed().response, model: 'other' } }),
    frame(created()) + frame({ ...completed(), response: { ...completed().response, error: {} } }),
    frame(created()) + frame({ ...completed(), response: { ...completed().response, incomplete_details: {} } })]) unknown(run(text));
});
test('trailing malformed/unsupported events and framing cannot be ignored', () => {
  for (const tail of ['data: {bad}\n\n', 'data: {}\n\n', 'garbage\n', 'id: private\n\n',
    'retry: 10\n\n', 'event: response.completed\n\n', frame({ type: 'response.output_text.delta', delta: 'x' }),
    'data: [DONE]\n\ndata: [DONE]\n\n']) unknown(run(valid() + tail));
  unknown(run('data: [DONE]\n\n' + valid()), 'invalid_done');
  unknown(run('event: response.failed\n' + valid()), 'event_type_mismatch');
});
test('explicit unknown event types and response-bearing interim envelopes refuse', () => {
  for (const event of [{ type: 'response.unknown' },
    { type: 'response.output_text.delta', response: response('in_progress') }]) unknown(run(frame(created()) + frame(event) + frame(completed())));
});
test('supplied event error evidence is sticky even under an otherwise supported type', () => {
  for (const error of [{ message: 'synthetic private payload' }, false, 0, 'error']) {
    unknown(run(frame(created()) + frame({ type: 'response.output_text.delta', error }) + frame(completed())), 'upstream_error');
  }
});
test('explicit response ID and completion envelope fields are strictly checked', () => {
  for (const id of ['', null, 1, {}, 'a'.repeat(LIMITS.id + 1), 'private space']) {
    const start = created(); start.response.id = id;
    unknown(run(frame(start) + frame(completed())), 'response_identity');
  }
  for (const [key, value] of [['model', null], ['object', 'other'], ['status', null]]) {
    const end = completed(); end.response[key] = value;
    unknown(run(frame(created()) + frame(end)), 'invalid_completed');
  }
  const end = completed(); delete end.response.model;
  unknown(run(frame(created()) + frame(end)), 'invalid_completed');
});
test('in-progress and item identity fields are not confused with response IDs', () => {
  const events = [created(), { type: 'response.in_progress', response: response('in_progress') },
    { type: 'response.output_item.added', item: { id: 'item_A', type: 'function_call', call_id: 'call_A' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item_A', delta: '{}' }, completed()];
  assert.equal(run(events.map(frame).join('')).state, 'known');
});
test('bounded total bytes, frame size and event count fail closed', () => {
  unknown(run(new Uint8Array(LIMITS.bytes + 1)), 'stream_limit');
  unknown(run(':' + 'x'.repeat(LIMITS.frame)), 'frame_limit');
  const state = createResponsesTerminal(options); state.push(bytes(frame(created())));
  const delta = bytes(frame({ type: 'response.output_text.delta' }));
  for (let i = 0; i < LIMITS.events; i++) state.push(delta);
  unknown(state.finish('eof'), 'event_limit');
});
test('post-finish operations and invalid chunks are sticky misuse refusals', () => {
  const state = createResponsesTerminal(options); state.push(bytes(valid()));
  assert.equal(state.finish('eof').state, 'known');
  unknown(state.push(bytes('')), 'input_after_finish');
  unknown(state.finish('eof'), 'input_after_finish');
  const other = createResponsesTerminal(options); other.push(bytes(valid())); other.finish('eof');
  unknown(other.finish('eof'), 'duplicate_finish');
  const third = createResponsesTerminal(options); unknown(third.push('private payload'), 'invalid_chunk');
});
test('unknown verdicts never expose response content, identity, usage or exception text', () => {
  const privateText = 'synthetic_private_123';
  const result = run(valid() + frame({ type: 'error', message: privateText, id: privateText }));
  unknown(result); assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(result).includes('resp_synthetic'), false);
});
