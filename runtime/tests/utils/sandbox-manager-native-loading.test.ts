import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

it('uses the same installed manager and leaf exports through native ESM and require', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.sandbox-native-'))
  try {
    const fixture = join(directory, 'fixture.ts')
    await writeFile(fixture, `
      export { loadSandboxManager } from '../src/utils/sandbox/loadSandboxManager.js';
      export { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js';
      export { SandboxViolationStore } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-violation-store.js';
    `)
    await build({ entryPoints: [fixture], outfile: join(directory, 'built.mjs'), bundle: true,
      format: 'esm', platform: 'node', packages: 'external' })
    const control = join(directory, 'control.mjs')
    await writeFile(control, `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const mode = process.argv[2];
      let attempts = 0;
      registerHooks({ load(url, context, next) {
        if (url.includes('/node_modules/node-forge/')) {
          attempts++;
          if (mode === 'blocked') throw new Error('forge-unavailable-control');
        }
        return next(url, context);
      }});
      const fixture = await import('./built.mjs');
      assert.equal(attempts, 0);
      assert(fixture.SandboxRuntimeConfigSchema.safeParse({}).success === false);
      assert(new fixture.SandboxViolationStore() instanceof fixture.SandboxViolationStore);
      assert.equal(attempts, 0);
      if (mode === 'blocked') {
        assert.throws(() => fixture.loadSandboxManager(), /forge-unavailable-control/);
        assert(attempts > 0);
      } else {
        const first = mode === 'require-first' ? fixture.loadSandboxManager() : null;
        const root = await import('@anthropic-ai/sandbox-runtime');
        assert(attempts > 0);
        assert.strictEqual(fixture.loadSandboxManager(), root.SandboxManager);
        if (first) assert.strictEqual(first, root.SandboxManager);
        assert.strictEqual(fixture.SandboxRuntimeConfigSchema, root.SandboxRuntimeConfigSchema);
        assert.strictEqual(fixture.SandboxViolationStore, root.SandboxViolationStore);
        assert.strictEqual(fixture.SandboxViolationStore.prototype, root.SandboxViolationStore.prototype);
        assert.deepEqual(fixture.loadSandboxManager().getFsReadConfig(), root.SandboxManager.getFsReadConfig());
        assert.equal(fixture.loadSandboxManager().isSupportedPlatform(), root.SandboxManager.isSupportedPlatform());
      }
      console.log('sandbox-native-ok:' + mode);
    `)
    for (const mode of ['blocked', 'require-first', 'import-first']) {
      const child = spawnSync(process.execPath, [control, mode], { encoding: 'utf8', timeout: 30000 })
      expect(child.status, `${mode}: ${child.stderr}`).toBe(0)
      expect(child.stdout.trim()).toBe(`sandbox-native-ok:${mode}`)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
