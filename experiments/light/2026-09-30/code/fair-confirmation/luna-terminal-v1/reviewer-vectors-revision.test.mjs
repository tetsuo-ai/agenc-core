// Copied reviewer vectors, unchanged assertions. Only relative module paths and
// expected successor source hash change; original review SHA256:
// 6fd1dfbffe537c04a727daf55f4181a8c69d77131eca365cca47280e4d22475b.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createResponsesTerminal } from './terminal.mjs';

assert.equal(createHash('sha256').update(readFileSync(new URL('./terminal.mjs', import.meta.url))).digest('hex'),
  'e489128312d8ce2220d35f8a052eeec797b0c4fce1ff7b78e5d39a785f52df70');
const bytes = text => new TextEncoder().encode(text);
const usage = {input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: {cached_tokens: 2}};
const response = status => ({id: 'resp_review', status, model: 'gpt-6-luna'});
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const start = frame({type: 'response.created', response: response('in_progress')});
const end = frame({type: 'response.completed', response: {...response('completed'), usage}});
const valid = start + end;
function parse(text = valid, contentType = 'text/event-stream', split = false) {
  const state = createResponsesTerminal({httpStatus: 200, contentType, expectedModel: 'gpt-6-luna'});
  if (split) for (const byte of bytes(text)) state.push(Uint8Array.of(byte));
  else state.push(bytes(text));
  return state.finish('eof');
}
function unknown(value) {
  assert.equal(value.state, 'unknown');
  assert.deepEqual(Object.keys(value).sort(), ['reason', 'state']);
  assert.equal(Object.isFrozen(value), true);
}

for (const [name, contentType] of [
  ['embedded LF', 'text/event-stream\n; charset=utf-8'],
  ['non-ASCII NBSP', 'text/event-stream;\u00a0charset=utf-8'],
  ['vertical tab', 'text/event-stream\v; charset=utf-8'],
]) test(`unsupported Content-Type whitespace refuses: ${name}`, () => {
  const result = parse(valid, contentType);
  unknown(result);
  assert.equal(result.reason, 'unsupported_transport');
});

test('control: documented case-insensitive type and ASCII optional whitespace work', () => {
  for (const type of ['text/event-stream', 'TEXT/EVENT-STREAM; CHARSET=UTF-8', 'text/event-stream \t;\t charset=utf-8']) {
    assert.equal(parse(valid, type).state, 'known');
  }
});

test('control: CRLF event fields and byte-split supplementary Unicode produce same bounded proof', () => {
  const text = ('event: response.created\n' + start
    + frame({type: 'response.output_text.delta', delta: 'review \u{1F989}'})
    + 'event: response.completed\n' + end).replaceAll('\n', '\r\n');
  assert.deepEqual(parse(text, 'text/event-stream', true), parse(valid));
  assert.equal(parse(text).chargeNanos, '2020');
});

test('control: escaped duplicate identity and usage keys refuse instead of choosing a value', () => {
  for (const suffix of [
    'data: {"type":"response.completed","response":{"id":"resp_review","i\\u0064":"resp_review"}}\n\n',
    end.replace('"input_tokens":7', '"input_tokens":7,"input_\\u0074okens":7'),
  ]) unknown(parse(start + suffix));
});

test('control: fractional exact cached/output/total counters cannot round to the expected integers', () => {
  for (const [oldValue, newValue] of [
    ['"cached_tokens":2', '"cached_tokens":2.00000000000000001'],
    ['"output_tokens":3', '"output_tokens":3.00000000000000001'],
    ['"total_tokens":10', '"total_tokens":10.00000000000000001'],
  ]) unknown(parse(start + end.replace(oldValue, newValue)));
});

test('control: wrong progress identity/model and late non-null error remain unknown', () => {
  for (const event of [
    {type: 'response.in_progress', response: {...response('in_progress'), id: 'resp_other'}},
    {type: 'response.in_progress', response: {...response('in_progress'), model: 'other'}},
    {type: 'response.output_text.delta', error: 0},
  ]) unknown(parse(start + frame(event) + end));
});

test('control: valid terminal plus partial UTF8 never becomes known even when EOF is reported', () => {
  const state = createResponsesTerminal({httpStatus: 200, contentType: 'text/event-stream', expectedModel: 'gpt-6-luna'});
  state.push(bytes(valid));
  state.push(Uint8Array.of(0xf0, 0x9f));
  unknown(state.finish('eof'));
});
