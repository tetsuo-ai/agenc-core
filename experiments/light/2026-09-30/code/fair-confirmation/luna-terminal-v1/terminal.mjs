// Pure offline prototype. No transport, persistence, reservation, or release authority.
import { createHash } from 'node:crypto';
import { usageCharge } from '../luna-finance-v1/accounting.mjs';
import { parseLedgerBytes } from '../luna-finance-v1/ledger-json.mjs';

export const LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, frame: 1024 * 1024,
  events: 100000, id: 240 });
export const DEPENDENCIES = Object.freeze({
  accounting: 'b602fcb75b42fb6671affb8de105fc7b661a8e4f258a0541db9d5952c271ac7e',
  ledgerJson: 'f7b034ba5def781b2e0246709734cf32f564f7bccdab7e138124b5895a0b2750',
});
const INTERIM = new Set([
  'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.output_text.delta', 'response.output_text.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
  'response.reasoning_text.delta', 'response.reasoning_text.done',
  'response.refusal.delta', 'response.refusal.done',
]);
const ERRORS = new Set(['error', 'response.failed', 'response.incomplete', 'response.cancelled']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const identity = id => typeof id === 'string' && id.length > 0 && id.length <= LIMITS.id
  && /^[A-Za-z0-9_-]+$/.test(id);

// The imported strict JSONL parser retains exact numeric lexemes. SSE multi-line
// data uses LF: only JSON whitespace outside strings is replaced, never arbitrary
// whitespace or malformed literal strings. Limits are checked before this copy.
function parseData(data) {
  let quoted = false, escaped = false, normalized = '';
  for (const c of data) {
    if (quoted) {
      if (c === '\n' || c === '\r') throw new Error('invalid JSON');
      normalized += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else {
      if (c === '"') quoted = true;
      normalized += c === '\n' ? ' ' : c;
    }
  }
  return parseLedgerBytes(new TextEncoder().encode(normalized + '\n'))[0];
}

/**
 * Supported lifecycle: HTTP 200 SSE, one created/in_progress response, one
 * completed response, optional [DONE], clean EOF. Missing created is unknown,
 * not a claim about every provider's lifecycle. Caller owns actual EOF truth.
 */
export function createResponsesTerminal({ httpStatus, contentType, expectedModel } = {}) {
  let reason = null, finished = false, terminal = false, done = false;
  let responseId = null, charge = null, bytes = 0, events = 0;
  let line = '', frameSize = 0, data = [], eventName = null, afterCR = false;
  let firstCharacter = true;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const fail = code => { reason ??= code; };
  if (httpStatus !== 200 || typeof contentType !== 'string'
      // Absolute end assertion also rejects a final line terminator (JS $ alone does not).
      || !/^text\/event-stream(?:[ \t]*;[ \t]*charset=utf-8)?(?![\s\S])/i.test(contentType)
      || expectedModel !== 'gpt-6-luna') fail('unsupported_transport');

  function snapshot() {
    if (reason || !finished || !terminal) return Object.freeze({
      state: 'unknown', reason: reason ?? (finished ? 'missing_terminal' : 'awaiting_eof'),
    });
    return Object.freeze({ state: 'known', proof: 'completed-full-usage-clean-eof-v1',
      responseIdSha256: createHash('sha256').update(responseId).digest('hex'),
      input: charge.input, output: charge.output, cached: charge.cached,
      chargeNanos: String(charge.nanos), priceId: charge.priceId,
    });
  }
  function responseMatches(response, status, requireModel) {
    return record(response) && identity(response.id) && response.id === responseId
      && response.status === status
      && (!requireModel && !own(response, 'model') || response.model === expectedModel)
      && (!own(response, 'object') || response.object === 'response')
      && (!own(response, 'error') || response.error === null)
      && (!own(response, 'incomplete_details') || response.incomplete_details === null);
  }
  function observe(event) {
    if (!record(event) || typeof event.type !== 'string') return fail('invalid_event');
    if (eventName !== null && eventName !== event.type) return fail('event_type_mismatch');
    if (ERRORS.has(event.type)) return fail('unsuccessful_terminal');
    if (own(event, 'error') && event.error !== null) return fail('upstream_error');
    if (terminal || done) return fail('event_after_terminal');
    if (event.type === 'response.created') {
      if (responseId !== null || !record(event.response) || !identity(event.response.id)) {
        return fail('response_identity');
      }
      responseId = event.response.id;
      if (!responseMatches(event.response, 'in_progress', false)) return fail('invalid_created');
    } else if (responseId === null) return fail('missing_created');
    if (own(event, 'response_id') && event.response_id !== responseId) return fail('response_identity');
    if (own(event, 'response') && (!record(event.response) || event.response.id !== responseId)) {
      return fail('response_identity');
    }
    if (event.type === 'response.created') return;
    if (event.type === 'response.in_progress') {
      if (!responseMatches(event.response, 'in_progress', false)) fail('invalid_progress');
      return;
    }
    if (event.type === 'response.completed') {
      if (!responseMatches(event.response, 'completed', true)) return fail('invalid_completed');
      try {
        charge = usageCharge(event.response.usage);
        if (!charge.completeCounters) return fail('incomplete_usage');
      } catch { return fail('invalid_usage'); }
      terminal = true;
      return;
    }
    if (!INTERIM.has(event.type)) return fail('unsupported_event');
    // Do not mistake function/item IDs for response IDs. Other response-bearing
    // interim shapes are unsupported, rather than silently ignoring status/error.
    if (own(event, 'response')) fail('unsupported_interim_response');
  }
  function frame() {
    if (reason) return;
    if (!data.length) {
      if (eventName !== null) fail('missing_event_data');
    } else {
      if (++events > LIMITS.events) return fail('event_limit');
      const payload = data.join('\n');
      if (payload === '[DONE]') {
        if (!terminal || done || eventName !== null) fail('invalid_done');
        else done = true;
      } else {
        try { observe(parseData(payload)); } catch { fail('malformed_json'); }
      }
    }
    data = []; eventName = null; frameSize = 0;
  }
  function consumeLine() {
    const current = line; line = '';
    if (!current) { frame(); return; }
    if (current.startsWith(':')) return;
    const colon = current.indexOf(':');
    const field = colon < 0 ? current : current.slice(0, colon);
    let value = colon < 0 ? '' : current.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event' && eventName === null && value.length > 0 && value.length <= 128) eventName = value;
    else fail('unsupported_sse_field');
  }
  function text(value) {
    for (const c of value) {
      if (reason) return;
      if (firstCharacter) { firstCharacter = false; if (c === '\ufeff') return fail('invalid_utf8'); }
      if (afterCR) { afterCR = false; if (c === '\n') continue; }
      if (++frameSize > LIMITS.frame) return fail('frame_limit');
      if (c === '\r' || c === '\n') {
        consumeLine(); afterCR = c === '\r';
      } else line += c;
    }
  }
  function push(chunk) {
    if (finished) fail('input_after_finish');
    if (reason) return snapshot();
    if (!(chunk instanceof Uint8Array)) { fail('invalid_chunk'); return snapshot(); }
    bytes += chunk.byteLength;
    if (bytes > LIMITS.bytes) { fail('stream_limit'); return snapshot(); }
    try { text(decoder.decode(chunk, { stream: true })); } catch { fail('invalid_utf8'); }
    return snapshot();
  }
  function finish(outcome) {
    if (finished) { fail('duplicate_finish'); return snapshot(); }
    finished = true;
    if (outcome !== 'eof') fail('unclean_transport');
    if (!reason) {
      try { text(decoder.decode()); } catch { fail('invalid_utf8'); }
      if (!reason && line) consumeLine();
      if (!reason) frame();
      if (!reason && !terminal) fail('missing_terminal');
    }
    return snapshot();
  }
  return Object.freeze({ push, finish, snapshot });
}
