import { expect, test } from 'vitest'
import { build } from 'esbuild'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('native bundled startup selection works without full rows; first full lookup throws and retries', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.catalog-native-'))
  try {
    const fixture = join(directory, 'fixture.ts')
    await writeFile(fixture, `
      export * from '../src/llm/registry/model-catalog.js';
      export * from '../src/llm/registry/provider-info.js';
      export { OPENROUTER_MODELS } from '../src/llm/registry/openrouter-models.js';
      export { mergeProviderModelLayer } from '../src/config/provider-model-authority.js';
      export { DEFAULT_MODEL_COSTS, conservativeModelCost } from '../src/session/cost.js';
    `)
    await build({ entryPoints: [fixture], outfile: join(directory, 'built.mjs'), bundle: true,
      format: 'esm', platform: 'node', packages: 'external' })
    await copyFile('src/llm/registry/openrouter-pricing.data.json', join(directory, 'openrouter-pricing.data.json'))
    const control = join(directory, 'control.mjs')
    await writeFile(control, `
      import assert from 'node:assert/strict';
      import { copyFileSync, writeFileSync } from 'node:fs';
      const fixture = await import('./built.mjs');
      assert.equal(fixture.mergeProviderModelLayer({}, {
        model_provider: 'deepseek', model: 'deepseek-flash',
      }).model, 'deepseek-flash');
      assert.equal(fixture.DEFAULT_BUILT_IN_PROVIDER_SELECTION.model, 'grok-4.6');
      assert(fixture.deriveFlatCatalog().openrouter.includes('openai/gpt-6-sol'));
      assert(fixture.conservativeModelCost().inputUsdPer1K > 0);
      assert(fixture.DEFAULT_MODEL_COSTS['openrouter:openai/gpt-6-sol']);
      const lookup = () => fixture.resolveRegisteredModelCatalogEntry({provider: 'openrouter', model: 'openai/gpt-6-sol'});
      assert.throws(lookup, { code: 'ENOENT' });
      const data = new URL('./openrouter-models.data.json', import.meta.url);
      writeFileSync(data, '[]');
      assert.throws(lookup, /does not match its model index/);
      copyFileSync(process.argv[2], data);
      const row = lookup();
      assert.equal(lookup(), row);
      assert.equal(row.model, 'openai/gpt-6-sol');
      assert.equal(fixture.listRegisteredModelCatalogEntries('openrouter').find(entry => entry.model === row.model), row);
      assert(Object.isFrozen(fixture.OPENROUTER_MODELS));
      assert.equal(fixture.REGISTERED_MODEL_CATALOG[0].inputModalities, fixture.OPENROUTER_MODELS[0].modalities);
      console.log('catalog-native-ok');
    `)
    const child = spawnSync(process.execPath, [control, resolve('src/llm/registry/openrouter-models.data.json')], {
      encoding: 'utf8', timeout: 30000,
    })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout.trim()).toBe('catalog-native-ok')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
