// Test only: no inherited credentials; install fake fetch before loading observer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.env.LUNA_RUN_DIR;
const spec = JSON.parse(fs.readFileSync(path.join(root, 'requests.json')));
let calls = 0, preparationCancels = 0, responseCancels = 0, resolveFake, gcState;
const tick = () => new Promise(resolve => setImmediate(resolve));
const forwarded = [], errors = [], redirects = [], statuses = [];
globalThis.fetch = async request => {
  calls++;
  const bytes = Buffer.from(await request.arrayBuffer());
  forwarded.push(crypto.createHash('sha256').update(bytes).digest('hex'));
  redirects.push(request.redirect);
  if (spec.requestMode === 'abort_fetch_gc') return new Promise(resolve => { resolveFake = resolve; });
  if (spec.requestMode === 'abort_body_gc') return new Response(new ReadableStream({
    cancel() { responseCancels++; }
  }), { headers: { 'content-type': 'text/event-stream' } });
  if (spec.responseMode === 'fetch_error') throw new Error('synthetic fetch failure');
  if (spec.responseMode === 'http_error') return new Response('synthetic HTTP refusal', { status: 503 });
  if (spec.responseMode === 'redirect') return new Response(null, { status: 307, headers: { location: 'https://example.invalid/' } });
  const response = { id: 'synthetic-response', model: 'gpt-6-luna', status: 'in_progress' };
  const complete = { ...response, status: 'completed', usage: { input_tokens: 100, output_tokens: 20,
    total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } };
  const events = [{ type: 'response.created', response }, { type: 'response.completed', response: complete }];
  if (spec.responseMode === 'late_error') events.push({ type: 'error' });
  const body = events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};
await import('./direct.mjs');
for (const body of spec.bodies) {
  try {
    const init = { method: 'POST', body: JSON.stringify(body) };
    let pending;
    if (spec.requestMode === 'abort_fetch_gc' || spec.requestMode === 'abort_body_gc') {
      const controller = new AbortController();
      let request = new Request('https://api.openai.com/v1/responses', { ...init, signal: controller.signal });
      const weak = new WeakRef(request);
      let state = 'pending', output;
      const observed = fetch(request).then(v => { output = v; state = 'response'; }, () => { state = 'refused'; });
      // Mutating the caller property must not be consulted during cleanup.
      Object.defineProperty(request, 'signal', { get() { throw new Error('synthetic late getter'); } });
      request = null;
      if (spec.requestMode === 'abort_fetch_gc') {
        for (let i = 0; !resolveFake && i < 1000; i++) await tick();
        if (!resolveFake) throw new Error('fake fetch not entered');
        for (let i = 0; i < 4; i++) { await tick(); globalThis.gc(); }
        controller.abort(); await tick();
        gcState = { state, originalRetained: weak.deref() !== undefined };
        resolveFake(new Response(new ReadableStream({ cancel() { responseCancels++; } }),
          { headers: { 'content-type': 'text/event-stream' } }));
        await observed;
        if (output) await output.body.cancel();
      } else {
        await observed;
        if (!output) throw new Error('missing synthetic response');
        const reader = output.body.getReader();
        let readState = 'pending';
        const read = reader.read().then(() => { readState = 'done'; }, () => { readState = 'refused'; });
        for (let i = 0; i < 4; i++) { await tick(); globalThis.gc(); }
        const originalRetained = weak.deref() !== undefined;
        controller.abort(); await tick();
        gcState = { state: readState, originalRetained };
        await reader.cancel().catch(() => undefined); await read;
      }
      await tick(); errors.push('refused'); continue;
    }
    if (spec.requestMode === 'abort_preparation') {
      const controller = new AbortController();
      const request = new Request('https://api.openai.com/v1/responses', { method: 'POST',
        body: new ReadableStream({ cancel() { preparationCancels++; } }), duplex: 'half', signal: controller.signal });
      pending = fetch(request);
      setImmediate(() => controller.abort());
    } else pending = fetch('https://api.openai.com/v1/responses', init);
    if (spec.mutateCaller) init.body = '{}';
    const response = await pending;
    statuses.push(response.status);
    await response.text();
    errors.push(null);
  } catch { errors.push('refused'); }
}
// Drain send callbacks before clean exit; a missing parent publication is not
// repaired into success by the fixture.
await new Promise(resolve => setImmediate(resolve));
fs.writeFileSync(path.join(root, 'outcome.json'), JSON.stringify({ calls, forwarded, errors, redirects, statuses, preparationCancels, responseCancels, gcState }), { flag: 'wx', mode: 0o600 });
if (process.connected) process.disconnect();


