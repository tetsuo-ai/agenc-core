import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const totalBalance = b => b.cash_balance + b.voucher_balance;

// Diagnostic endpoints do not generate tokens. Retry a transient timeout once
// with a fresh signal; never retry authentication or exhausted-account errors.
export async function readOnlyJson(fetchImpl, url, init = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, {...init, signal: AbortSignal.timeout(30000)});
      const data = await response.json();
      if (response.ok) return data;
      const error = new Error(`Moonshot diagnostic HTTP ${response.status}`);
      error.retryable = response.status >= 500 || (response.status === 429 &&
        !/quota|balance|funds/i.test(String(data.error?.type ?? '') + String(data.error?.message ?? '')));
      throw error;
    } catch (error) {
      if (attempt || !(error.retryable || ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name))) throw error;
    }
  }
}

// A byte-for-byte appended conversation needs no second large tokenizer call.
// Keep the calibrated base and bound every added UTF-8 byte as a token. A
// changed prefix, model or image-bearing tail must be calibrated afresh.
export function appendedTokenBound(previous, model, messages) {
  if (!previous || previous.model !== model || previous.messages.length === 0 ||
      messages.length < previous.messages.length ||
      JSON.stringify(messages.slice(0, previous.messages.length)) !== JSON.stringify(previous.messages)) return undefined;
  const tail = messages.slice(previous.messages.length);
  if (tail.some(m => Array.isArray(m.content) && m.content.some(p => p.type !== 'text'))) return undefined;
  return Math.ceil(previous.tokens * 1.1) + Buffer.byteLength(JSON.stringify(tail));
}
// USD per million tokens, read from the rendered official pricing table on
// 2026-10-23: https://platform.kimi.ai/docs/pricing/chat
// The default 5m cache-write rate equals ordinary input, not an added fee.
export const RATES = Object.freeze({
  'kimi-k3.1-pro': [2, 10, 0.2],
  'kimi-k3.1-pro-highspeed': [4, 20, 0.2],
  'kimi-k3': [3, 15, 0.3],
  'kimi-k2.7-code': [0.95, 4, 0.19],
  'kimi-k2.7-code-highspeed': [1.9, 8, 0.38],
  'kimi-k2.6': [0.95, 4, 0.16],
});
export function usageCost(model, usage, oneHourWrites = 0) {
  const rates = RATES[model];
  if (!rates || !Number.isFinite(usage?.prompt_tokens) || !Number.isFinite(usage?.completion_tokens)) {
    throw new Error('Missing price or usage; retain the reservation');
  }
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
  if (cached < 0 || cached > usage.prompt_tokens) throw new Error('Invalid cache usage');
  if (!Number.isSafeInteger(oneHourWrites) || oneHourWrites < 0 || oneHourWrites > (usage.prompt_tokens_details?.cache_write_tokens ?? 0)) {
    throw new Error('Invalid one-hour cache writes');
  }
  return ((usage.prompt_tokens - cached + oneHourWrites) * rates[0] + usage.completion_tokens * rates[1] + cached * rates[2]) / 1e6;
}
// Balance updates can lag streamed usage. Never interpret an unchanged balance
// as free inference. Keep a 10% margin on priced usage until charges catch up.
export const budgetSpend = ledger => Math.max(ledger.spent, (ledger.priorSpend ?? 0) + (ledger.usageSpend ?? 0) * 1.1);
export function reconcile(ledger, balance) {
  for (const name of ['cash_balance', 'voucher_balance', 'available_balance']) {
    if (!Number.isFinite(balance[name])) throw new Error('Invalid Moonshot balance');
  }
  const delta = totalBalance(ledger.lastBalance) - totalBalance(balance);
  return { ...ledger, spent: ledger.spent + Math.max(0, delta), lastBalance: balance };
}
export function reserveUsd(body, inputTokenBound) {
  const output = body.max_completion_tokens ?? body.max_tokens;
  if (!Number.isInteger(output) || output < 1 || output > 4096) throw new Error('Unbounded sweep output');
  // Admission envelope, not a published model price. UTF-8 bytes upper-bound
  // text tokens. Image requests add a separate conservative token reserve.
  const images = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length;
  if (inputTokenBound !== undefined && (!Number.isInteger(inputTokenBound) || inputTokenBound < 1)) {
    throw new Error('Invalid input token bound');
  }
  const bytesBound = Buffer.byteLength(JSON.stringify(body)) + images * 32000;
  return Math.min(bytesBound, inputTokenBound ?? bytesBound) * 12 / 1e6 + output * 40 / 1e6;
}
export function admit(ledger, body, inputTokenBound) {
  if (ledger.pending) throw new Error('Unsettled request reservation');
  const reserve = reserveUsd(body, inputTokenBound);
  const accounted = budgetSpend(ledger);
  if (accounted + reserve > ledger.cap) throw new Error('Owner spend cap reached');
  if (ledger.balanceFloor !== undefined && ledger.lastBalance.available_balance - (accounted - ledger.spent) - reserve < ledger.balanceFloor) {
    throw new Error('Moonshot balance floor reached');
  }
  return reserve;
}

const controlPath = process.env.KIMI_SWEEP_CONTROL;
if (controlPath) {
  const original = globalThis.fetch;
  const key = process.env.MOONSHOT_API_KEY;
  const save = (file, value) => {
    writeFileSync(file+'.tmp', JSON.stringify(value, null, 2)+'\n', {mode: 0o600});
    renameSync(file+'.tmp', file);
  };
  async function balance() {
    const data = await readOnlyJson(original, 'https://api.moonshot.ai/v1/users/me/balance', {
      headers: {Authorization: 'Bearer '+key},
    });
    return data.data;
  }
  let calibration;
  let queue = Promise.resolve();
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url !== 'https://api.moonshot.ai/v1/chat/completions') return original(input, init);
    // A single active request keeps reservations and balance deltas attributable.
    const prior = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await prior;
    let streaming = false;
    let stage = 'request';
    const control = JSON.parse(readFileSync(controlPath, 'utf8'));
    const log = entry => appendFileSync(control.wire, JSON.stringify({...entry, run: control.run})+'\n', {mode: 0o600});
    try {
      const body = JSON.parse(String(init?.body));
      let inputTokenBound;
      let reusedCalibration = false;
      if (Buffer.byteLength(JSON.stringify(body)) > 64000) {
        // Calibrate large requests rather than treating every UTF-8 byte as
        // a token. The endpoint estimates the conversation; reserve tool
        // definitions separately by bytes plus framing and a 10% margin.
        stage = 'token-estimate';
        const appended = appendedTokenBound(calibration, body.model, body.messages);
        if (appended !== undefined) {
          reusedCalibration = true;
          inputTokenBound = appended + Buffer.byteLength(JSON.stringify(body.tools ?? [])) + 1024;
        } else {
          const estimate = await readOnlyJson(original, 'https://api.moonshot.ai/v1/tokenizers/estimate-token-count', {
            method: 'POST', headers: {Authorization: 'Bearer '+key, 'Content-Type': 'application/json'},
            body: JSON.stringify({model: body.model, messages: body.messages}),
        });
        const count = estimate.data?.total_tokens;
        if (!Number.isInteger(count) || count < 1) throw new Error('Invalid tokenizer response');
        calibration = {model: body.model, messages: body.messages, tokens: count};
        inputTokenBound = Math.ceil(count * 1.1) + Buffer.byteLength(JSON.stringify(body.tools ?? [])) + 1024;
        }
      }
      stage = 'balance-before';
      let ledger = reconcile(JSON.parse(readFileSync(control.ledger, 'utf8')), await balance());
      save(control.ledger, ledger);
      if (ledger.lastBalance.available_balance <= 0 && !control.quotaProbe) throw new Error('Moonshot account needs funding');
      const reserve = admit(ledger, body, inputTokenBound);
      ledger = {...ledger, pending: {run: control.run, reserve}};
      save(control.ledger, ledger);
      const started = Date.now();
      const entry = {started, model: body.model, bytes: Buffer.byteLength(JSON.stringify(body)), inputTokenBound, reusedCalibration,
        maxOutput: body.max_completion_tokens ?? body.max_tokens, effort: body.reasoning_effort,
        thinking: body.thinking, stream: body.stream,
        cacheOptions: body.prompt_cache_options, cacheKeyHash: body.prompt_cache_key ? digest(body.prompt_cache_key) : undefined,
        systemPrefixHash: digest(body.messages[0]), toolsHash: digest(body.tools ?? []),
        images: body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url').length,
        messages: body.messages.map(m => ({role: m.role, toolCallId: m.tool_call_id,
          reasoningHash: m.reasoning_content === undefined ? undefined : digest(m.reasoning_content),
          reasoningLength: m.reasoning_content?.length,
          // Tool output evidence is generated solely by the isolated fixtures.
          toolOutput: m.role === 'tool' ? String(m.content).slice(0, 12000) : undefined,
          toolCalls: m.tool_calls})), reserve};
      stage = 'chat';
      const response = await original(input, init);
      // Only billing counts, never arbitrary headers or authorization values.
      entry.cacheWrite5m = Number(response.headers.get('Msh-Usage-Cache-Write-Tokens-5m') ?? 0);
      entry.cacheWrite1h = Number(response.headers.get('Msh-Usage-Cache-Write-Tokens-1h') ?? 0);
      // Tee capture preserves the CLI stream. The daemon owns this task until
      // its response is fully drained. The runner waits for the ledger to settle.
      const capture = async () => {
        const raw = await response.clone().text();
        const chunks = body.stream && response.ok
          ? raw.split('\n').filter(s => s.startsWith('data: ') && s !== 'data: [DONE]').map(s => JSON.parse(s.slice(6)))
          : [JSON.parse(raw)];
        let reasoning = '';
        let text = '';
        const calls = new Map();
        for (const chunk of chunks) {
          if (chunk.usage) entry.usage = chunk.usage;
          if (chunk.error) entry.error = {type: chunk.error.type,
            message: String(chunk.error.message ?? '').replaceAll(key ?? '\0', '[redacted]')
              .replace(/org-[a-z0-9]+|<ak-[^>]+>/gi, '[account]')};
          for (const choice of chunk.choices ?? []) {
            const m = choice.delta ?? choice.message ?? {};
            reasoning += m.reasoning_content ?? '';
            text += m.content ?? '';
            if (choice.finish_reason) entry.finish = choice.finish_reason;
            for (const [offset, c] of (m.tool_calls ?? []).entries()) {
              const i = c.index ?? offset;
              const prev = calls.get(i) ?? {id: '', name: '', arguments: ''};
              prev.id += c.id ?? ''; prev.name += c.function?.name ?? ''; prev.arguments += c.function?.arguments ?? '';
              calls.set(i, prev);
            }
          }
        }
        const after = await balance();
        const settled = reconcile(ledger, after);
        const pricedCost = response.ok ? usageCost(body.model, entry.usage, entry.cacheWrite1h) : 0;
        if (inputTokenBound !== undefined && entry.usage?.prompt_tokens > inputTokenBound) {
          throw new Error('Prompt usage exceeded its reservation bound');
        }
        settled.usageSpend = (ledger.usageSpend ?? 0) + pricedCost;
        delete settled.pending;
        save(control.ledger, settled);
        log({...entry, status: response.status, secs: (Date.now()-started)/1000,
          reasoningHash: digest(reasoning), reasoningLength: reasoning.length, text, tools: [...calls.values()],
          balanceBefore: ledger.lastBalance, balanceAfter: after,
          cost: pricedCost, balanceCost: Math.max(0, totalBalance(ledger.lastBalance)-totalBalance(after)), spent: settled.spent});
      };
      if (!response.ok) await capture();
      else {
        streaming = true;
        void capture().catch(() => log({status: 'capture-error'})).finally(release);
        return response;
      }
      return response;
    } catch (error) {
      // No request headers, request objects or credential values are logged.
      log({status: 'guard-or-transport-error', stage, error: error instanceof Error ? error.message.replaceAll(key ?? '\0', '[redacted]') : 'unknown'});
      throw error;
    } finally {
      // A successful streamed request keeps the reservation until capture ends.
      if (!streaming) release();
    }
  };
}
