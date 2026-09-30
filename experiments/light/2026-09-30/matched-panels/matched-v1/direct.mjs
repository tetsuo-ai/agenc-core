// Direct API observation and admission. No listener, forwarding server or key file.
import fs from 'node:fs';
import path from 'node:path';

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

if (root && dir && rid) globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== 'api.openai.com' || url.protocol !== 'https:') throw new Error('Luna requires the direct official API');
  if (url.pathname === '/v1/models' && (!init?.method || init.method === 'GET')) return nativeFetch(input, init);
  if (url.pathname !== '/v1/responses') throw new Error('Only direct Responses generation is admitted');
  if (fs.existsSync(stop)) throw new Error('Luna launches stopped; a transport check is required');
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : '');
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
    stamp = Date.now() / 1000;
    append({ event: 'admit', id: `${rid}:${n}`, run: rid, call: n, reserve, time: stamp });
    write(`wire-${String(n).padStart(3, '0')}.json`, { time: stamp, body });
  } finally { fs.rmdirSync(lock); }
  const suffix = String(n).padStart(3, '0');
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
    timing.headers_at = Date.now() / 1000;
    if (!response.ok) {
      const problem = await response.clone().text();
      const billing = /insufficient_quota|billing|credit_balance|payment_required/i.test(problem);
      halt(billing ? 'billing_error' : `http_${response.status}`);
      finish({ status: response.status });
      return response;
    }
    if (!body.stream) {
      const value = await response.clone().json(); usage = value.usage;
      fs.writeSync(fd, JSON.stringify(value)); finish(); return response;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { observe(decoder.decode()); finish(); controller.close(); return; }
          fs.writeSync(fd, value); observe(decoder.decode(value, { stream: true })); controller.enqueue(value);
        } catch {
          halt('stream_error'); finish({ type: 'stream_error' }); controller.error(new Error('Luna stream failed'));
        }
      },
      async cancel(reason) { finish({ type: 'cancelled' }); await reader.cancel(reason); },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    halt('fetch_error'); finish({ type: 'fetch_error' }); throw new Error('Direct Luna request failed');
  }
};
