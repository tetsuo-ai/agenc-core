// Test only: no inherited credentials; install fake fetch before loading observer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.env.LUNA_RUN_DIR;
const spec = JSON.parse(fs.readFileSync(path.join(root, 'requests.json')));
let calls = 0, preparationCancels = 0;
const forwarded = [], errors = [], redirects = [], statuses = [];
globalThis.fetch = async request => {
  calls++;
  const bytes = Buffer.from(await request.arrayBuffer());
  forwarded.push(crypto.createHash('sha256').update(bytes).digest('hex'));
  redirects.push(request.redirect);
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
fs.writeFileSync(path.join(root, 'outcome.json'), JSON.stringify({ calls, forwarded, errors, redirects, statuses, preparationCancels }), { flag: 'wx', mode: 0o600 });
if (process.connected) process.disconnect();
