import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

const source = new URL('../../src/llm/undici-dispatcher.ts', import.meta.url)

describe('narrow Undici dispatcher loading', () => {
  it('loads only dispatcher modules, preserves the package identities and retries a failed load', () => {
    const code = `
      import { createRequire } from 'node:module';
      const nativeRequire = createRequire(import.meta.url);
      let blocked = true;
      globalThis.require = (path) => {
        if (blocked && path === 'undici/lib/global.js') throw new Error('dispatcher unavailable');
        return nativeRequire(path);
      };
      const core = await import(${JSON.stringify(source.href)});
      if (nativeRequire.cache[nativeRequire.resolve('undici')]) throw new Error('eager Undici barrel');
      let failed = false;
      try { core.loadUndiciAgent(); } catch (error) { failed = error.message === 'dispatcher unavailable'; }
      if (!failed) throw new Error('load failure did not propagate');
      blocked = false;
      const Agent = core.loadUndiciAgent();
      const ProxyAgent = core.loadUndiciEnvHttpProxyAgent();
      const dispatcher = core.getUndiciGlobalDispatcher();
      if (nativeRequire.cache[nativeRequire.resolve('undici')]) throw new Error('core loaded full Undici barrel');
      for (const name of ['request','stream','pipeline','connect','upgrade','compose']) {
        if (typeof Agent.prototype[name] !== 'function') throw new Error('missing dispatcher API: '+name);
      }
      const full = await import('undici');
      if (full.Agent !== Agent || full.EnvHttpProxyAgent !== ProxyAgent || full.getGlobalDispatcher() !== dispatcher) throw new Error('split Undici identity');
      const custom = new Agent();
      full.setGlobalDispatcher(custom);
      if (core.getUndiciGlobalDispatcher() !== custom) throw new Error('global dispatcher override lost');
      full.setGlobalDispatcher(dispatcher);
      await custom.close();
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(0)
  })

  it.each(['core-first', 'root-first'])('shares constructors, methods and globals in a real bundle: %s', order => {
    const directory = mkdtempSync(join(tmpdir(), 'undici-core-bundle-'))
    try {
      const code = `
        import * as core from ${JSON.stringify(source.pathname)};
        let full;
        if (process.argv[2] === 'root-first') full = await import('undici');
        const Agent = core.loadUndiciAgent();
        const ProxyAgent = core.loadUndiciEnvHttpProxyAgent();
        const dispatcher = core.getUndiciGlobalDispatcher();
        const methods = Object.fromEntries(['request','stream','pipeline','connect','upgrade','compose'].map(name => [name, Agent.prototype[name]]));
        for (const [name, method] of Object.entries(methods)) if (typeof method !== 'function') throw new Error('missing API '+name);
        full ??= await import('undici');
        if (full.Agent !== Agent || full.EnvHttpProxyAgent !== ProxyAgent || full.getGlobalDispatcher() !== dispatcher) throw new Error('bundle identity split');
        for (const [name, method] of Object.entries(methods)) if (full.Agent.prototype[name] !== method) throw new Error('method identity split '+name);
        const custom = new Agent();
        full.setGlobalDispatcher(custom);
        if (core.getUndiciGlobalDispatcher() !== custom) throw new Error('global override lost');
        full.setGlobalDispatcher(dispatcher);
        await custom.close();
      `
      const result = buildSync({
        stdin: { contents: code, resolveDir: process.cwd(), sourcefile: 'undici-control.mjs' },
        bundle: true, platform: 'node', format: 'esm', target: 'node26', write: false,
        banner: { js: "import { createRequire as controlRequire } from 'node:module'; const require = controlRequire(import.meta.url);" },
      })
      const output = join(directory, 'control.mjs')
      writeFileSync(output, result.outputFiles[0]!.text)
      const child = spawnSync(process.execPath, [output, order], { encoding: 'utf8' })
      expect(child.status, child.stderr).toBe(0)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
