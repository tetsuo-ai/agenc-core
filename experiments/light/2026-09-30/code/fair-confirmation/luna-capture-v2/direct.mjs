// Direct API observation and admission. No listener, forwarding server or key file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Prospective capture contract. This is NOT the observer used by old runners.
const ADAPTER_PIN = 'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,240}$/.test(value);
const need = condition => { if (!condition) throw new Error('Invalid prospective capture metadata or initial request'); };
function regularBytes(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { need(fs.fstatSync(fd).isFile()); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
const observerHash = sha(regularBytes(fileURLToPath(import.meta.url)));
function runnerMetadata() {
  try {
    need(root && dir && identity(rid));
    const raw = regularBytes(process.env.LUNA_CAPTURE_METADATA);
    need(digest(process.env.LUNA_CAPTURE_METADATA_SHA256) && sha(raw) === process.env.LUNA_CAPTURE_METADATA_SHA256);
    const meta = JSON.parse(raw);
    const fields = ['schema_version', 'contract', 'protocol_id', 'run_id', 'root_turn_id', 'route',
      'task_prompt_sha256', 'observer_source_sha256', 'installed_adapter_sha256', 'installed_adapter_path'];
    need(Object.keys(meta).sort().join() === fields.sort().join());
    need(meta.schema_version === 2 && meta.contract === 'prospective-output-capture-v2');
    need(identity(meta.protocol_id) && identity(meta.root_turn_id) && meta.run_id === rid && meta.route === 'openai-direct');
    need(digest(meta.task_prompt_sha256) && meta.observer_source_sha256 === observerHash);
    need(meta.installed_adapter_sha256 === ADAPTER_PIN && path.isAbsolute(meta.installed_adapter_path));
    need(sha(regularBytes(meta.installed_adapter_path)) === ADAPTER_PIN);
    return meta;
  } catch { throw new Error('Invalid prospective capture metadata or initial request'); }
}
function bindInitial(body, meta) {
  need(body.previous_response_id == null && body.conversation == null && Array.isArray(body.input) && body.input.length > 0);
  let prompt;
  for (const [index, item] of body.input.entries()) {
    need(item && typeof item === 'object' && !Array.isArray(item) && ['system', 'developer', 'user'].includes(item.role));
    need((item.type ?? 'message') === 'message' && !['tool_calls', 'tool_call_id', 'call_id', 'function_call'].some(key => key in item));
    if (item.role === 'user') {
      need(prompt === undefined && index === body.input.length - 1);
      let content = item.content;
      if (Array.isArray(content)) {
        need(content.length === 1 && content[0]?.type === 'input_text' && Object.keys(content[0]).sort().join() === 'text,type');
        content = content[0].text;
      }
      need(typeof content === 'string'); prompt = content;
    }
  }
  need(typeof prompt === 'string' && sha(Buffer.from(prompt)) === meta.task_prompt_sha256);
}
function syncDir() {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeAll(fd, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(count) || count <= 0) throw new Error('Capture write incomplete');
    offset += count;
  }
}
function durableExclusive(name, bytes) {
  const fd = fs.openSync(path.join(dir, name), 'wx', 0o600);
  try { writeAll(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir();
}
function publishReceipt(name, bytes) {
  const pending = name + '.pending';
  const target = path.join(dir, name);
  let published = false;
  try {
    durableExclusive(pending, bytes);
    // Same-filesystem hard-link publication is atomic and refuses replacement.
    fs.linkSync(path.join(dir, pending), target); published = true;
    syncDir();
  } catch (error) {
    if (published) {
      try { fs.unlinkSync(target); syncDir(); } catch { /* Inventory must fail closed on I/O uncertainty. */ }
    }
    throw error;
  }
}
function capture(meta, n, raw, body) {
  const suffix = String(n).padStart(3, '0');
  const hash = crypto.createHash('sha256');
  let count = 0, fd, healthy = true, complete = false;
  // Optional scoring artifacts MUST NOT influence financial settlement/send.
  try {
    durableExclusive(`capture-request-${suffix}.json`, Buffer.from(raw));
    fd = fs.openSync(path.join(dir, `capture-response-${suffix}.sse`), 'wx', 0o600);
  } catch { healthy = false; }
  return {
    add(bytes) {
      hash.update(bytes); count += bytes.byteLength;
      if (fd !== undefined && healthy) {
        try { writeAll(fd, bytes); } catch { healthy = false; }
      }
    },
    finish(outcome, status, contentType, deliveryFailed) {
      if (complete) return; complete = true;
      try {
        if (fd !== undefined) {
          try { fs.fsyncSync(fd); } catch { healthy = false; }
          try { fs.closeSync(fd); } catch { healthy = false; }
          fd = undefined;
        } else healthy = false;
        try { syncDir(); } catch { healthy = false; }
        const receipt = {
          schema_version: 1, protocol_id: meta.protocol_id, run_id: rid, root_turn_id: meta.root_turn_id,
          request_role: n === 1 ? 'root' : 'continuation', admission_id: `${rid}:${n}`,
          call_ordinal: n, prior_root_generations: n - 1, initial_request: n === 1,
          route: meta.route, source: 'provider_response_sse', request_body_sha256: sha(Buffer.from(raw)),
          task_prompt_sha256: meta.task_prompt_sha256, response_bytes_sha256: hash.digest('hex'),
          response_byte_count: count, http_status: status, response_content_type: contentType,
          requested_stream: body.stream === true, transport_outcome: outcome,
          downstream_delivery_failed: deliveryFailed, capture_write_complete: healthy,
          observer_source_sha256: observerHash, installed_adapter_sha256: ADAPTER_PIN,
        };
        // Publication is non-replacing. A crash leaves absent/partial evidence,
        // never permission to infer clean EOF from the raw response file alone.
        publishReceipt(`capture-receipt-${suffix}.json`, Buffer.from(JSON.stringify(receipt) + '\n'));
      } catch { /* Missing/invalid receipt = unknown; never retry or touch ledger. */ }
    },
  };
}

const root = process.env.LUNA_LEDGER_ROOT;
const dir = process.env.LUNA_RUN_DIR;
const rid = process.env.LUNA_RUN_ID;
const adaptive = process.env.LUNA_ALLOW_ADAPTIVE === '1';
const adaptiveHigh = adaptive && process.env.LUNA_ADAPTIVE_HIGH === '1';
const taskCap = Number(process.env.LUNA_TASK_CALL_CAP || 45);
const ledger = root && path.join(root, 'luna-api-ledger.jsonl');
const stop = root && path.join(root, 'luna-api-stop.json');
const nativeFetch = globalThis.fetch;
const append = row => {
  const fd = fs.openSync(ledger, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};
const rows = () => fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + '\n');
const halt = (reason, settings) => {
  const fd = fs.openSync(stop, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ reason, run: rid, time: Date.now() / 1000, ...(settings ? { settings } : {}) }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const directoryFd = fs.openSync(root, 'r');
  try { fs.fsyncSync(directoryFd); }
  finally { fs.closeSync(directoryFd); }
};
const safeSettings = body => {
  const effort = body.reasoning?.effort;
  const cap = body.max_output_tokens;
  return {
    model_matches: body.model === 'gpt-6-luna',
    reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) ? effort : 'invalid',
    output_cap: typeof cap === 'number' && Number.isFinite(cap) ? cap : null,
    output_cap_type: cap === null ? 'null' : Array.isArray(cap) ? 'array' : typeof cap,
  };
};

globalThis.fetch = async (input, init) => {
  const meta = runnerMetadata();
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== 'api.openai.com' || url.protocol !== 'https:') throw new Error('Luna requires the direct official API');
  if (url.pathname === '/v1/models' && (!init?.method || init.method === 'GET')) return nativeFetch(input, init);
  if (url.pathname !== '/v1/responses') throw new Error('Only direct Responses generation is admitted');
  if (fs.existsSync(stop)) throw new Error('Luna launches stopped; a transport check is required');
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : '');
  need(typeof raw === 'string');
  const body = JSON.parse(raw);
  const outputCap = body.max_output_tokens;
  if (body.model !== 'gpt-6-luna' || !(body.reasoning?.effort === 'low' || (adaptive && body.reasoning?.effort === 'medium') || (adaptiveHigh && body.reasoning?.effort === 'high')) || !Number.isInteger(outputCap) || outputCap < 1 || outputCap > 8192) {
    halt('unexpected_model_settings', safeSettings(body)); throw new Error('Unpriced or unequal Luna settings');
  }
  // One run is admitted by the Python flock; this lock also excludes concurrent
  // fetches from its CLI and daemon processes. A conflict fails closed.
  const lock = path.join(root, 'luna-api-admission.lock');
  fs.mkdirSync(lock);
  let n, reserve, stamp;
  try {
    const history = rows();
    const admissions = history.filter(r => r.event === 'admit');
    const settled = new Map(history.filter(r => r.event === 'settle').map(r => [r.id, r]));
    const used = admissions.reduce((sum, r) => sum + (settled.get(r.id)?.budget_charge_usd ?? r.reserve), 0);
    n = admissions.filter(r => r.run === rid).length + 1;
    reserve = (Buffer.byteLength(JSON.stringify(body)) * 0.20 + outputCap * 0.75) / 1e6;
    if (n > taskCap) {
      halt('task_call_cap'); throw new Error('Luna per-task call limit reached');
    }
    if (n === 1) bindInitial(body, meta);
    stamp = Date.now() / 1000;
    append({ event: 'admit', id: `${rid}:${n}`, run: rid, call: n, reserve, time: stamp });
    write(`wire-${String(n).padStart(3, '0')}.json`, { time: stamp, body });
  } finally { fs.rmdirSync(lock); }
  const suffix = String(n).padStart(3, '0');
  const captured = capture(meta, n, raw, body);
  let httpStatus = null, contentType = null, cancelled = false, outerFailure = 'fetch_error';
  const timing = { request_start_at: stamp, headers_at: null, first_token_at: null, last_token_at: null, stream_end_at: null };
  const toolIds = new Set();
  let usage = null, pending = '', finished = false;
  const fd = fs.openSync(path.join(dir, `response-${suffix}.txt`), 'w', 0o600);
  function observe(text) {
    pending += text;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
      if (event.type?.endsWith('.delta') && event.delta) {
        const now = Date.now() / 1000;
        timing.first_token_at ??= now; timing.last_token_at = now;
      }
      if (event.response?.usage) usage = event.response.usage;
      if (event.item?.type === 'function_call') toolIds.add(event.item.call_id ?? event.item.id);
      if (['error', 'response.failed'].includes(event.type)) halt('upstream_event');
    }
  }
  function finish(error = null) {
    if (finished) return; finished = true;
    timing.stream_end_at = Date.now() / 1000;
    fs.closeSync(fd);
    const inp = usage?.input_tokens ?? 0, out = usage?.output_tokens ?? 0;
    const hit = usage?.input_tokens_details?.cached_tokens ?? 0;
    const rate = inp > 272000 ? [0.02, 0.20, 0.75] : [0.01, 0.10, 0.50];
    const cost = usage ? (hit * rate[0] + (inp - hit) * rate[1] + out * rate[2]) / 1e6 : null;
    const charge = cost ?? reserve;
    const record = { run: rid, call: n, model: body.model, time: stamp, seconds: timing.stream_end_at - stamp,
      input_tokens: inp, output_tokens: out, cached_tokens: hit, uncached_tokens: inp - hit,
      tool_calls: toolIds.size, usage: usage ?? {}, usage_missing: !usage, cost_usd: cost,
      budget_charge_usd: charge, cost_basis: 'official-openai-api-list-rate', rates: rate, timing, error };
    write(`usage-${suffix}.json`, record);
    append({ event: 'settle', id: `${rid}:${n}`, ...record });
  }
  try {
    const response = await nativeFetch(input, init);
    httpStatus = response.status; contentType = response.headers.get('content-type');
    outerFailure = 'read_error';
    timing.headers_at = Date.now() / 1000;
    if (!response.ok) {
      const problemBytes = new Uint8Array(await response.clone().arrayBuffer());
      captured.add(problemBytes);
      const problem = new TextDecoder().decode(problemBytes);
      const billing = /insufficient_quota|billing|credit_balance|payment_required/i.test(problem);
      halt(billing ? 'billing_error' : `http_${response.status}`);
      finish({ status: response.status });
      captured.finish('http_error', httpStatus, contentType, false);
      return response;
    }
    if (!body.stream) {
      outerFailure = 'nonstream_error';
      const bytes = new Uint8Array(await response.clone().arrayBuffer()); captured.add(bytes);
      const value = JSON.parse(new TextDecoder().decode(bytes)); usage = value.usage;
      fs.writeSync(fd, JSON.stringify(value)); finish();
      captured.finish('nonstream', httpStatus, contentType, false); return response;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            observe(decoder.decode()); finish();
            try { controller.close(); } catch {
              captured.finish('delivery_error', httpStatus, contentType, true); throw new Error('Delivery failed');
            }
            captured.finish('eof', httpStatus, contentType, false); return;
          }
          captured.add(value);
          fs.writeSync(fd, value); observe(decoder.decode(value, { stream: true }));
          try { controller.enqueue(value); } catch {
            captured.finish('delivery_error', httpStatus, contentType, true); throw new Error('Delivery failed');
          }
        } catch {
          if (cancelled) return;
          try { halt('stream_error'); finish({ type: 'stream_error' }); }
          finally { captured.finish('read_error', httpStatus, contentType, true); }
          controller.error(new Error('Luna stream failed'));
        }
      },
      async cancel(reason) {
        cancelled = true;
        try { finish({ type: 'cancelled' }); await reader.cancel(reason); }
        finally { captured.finish('cancelled', httpStatus, contentType, true); }
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    try { halt('fetch_error'); finish({ type: 'fetch_error' }); }
    finally { captured.finish(outerFailure, httpStatus, contentType, true); }
    throw new Error('Direct Luna request failed');
  }
};
