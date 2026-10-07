import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = new URL("../../src/utils/lazy-runtime-packages.ts", import.meta.url);

describe("lazy installed runtime packages", () => {
  it("loads nothing on import, propagates failures and preserves the ESM exports", () => {
    const directory = mkdtempSync(join(process.cwd(), ".lazy-package-"));
    try {
      const file = join(directory, "control.mjs");
      writeFileSync(file, `
        import assert from 'node:assert/strict';
        import { registerHooks } from 'node:module';
        const loads = [];
        let blocked;
        const failure = new Error('package unavailable');
        const hook = registerHooks({
          resolve(specifier, context, next) {
            if (specifier === blocked) throw failure;
            return next(specifier, context);
          },
          load(url, context, next) {
            if (['diff', 'tar', 'vscode-jsonrpc', 'chokidar', 'readdirp', 'js-yaml'].some(name => url.includes('/node_modules/' + name + '/'))) loads.push(url);
            return next(url, context);
          }
        });
        const core = await import(${JSON.stringify(source.href)});
        assert.equal(loads.length, 0, 'package loaded before first operation');
        for (const [specifier, loader, names] of [
          ['diff', 'loadDiff', ['structuredPatch', 'diffLines']],
          ['tar', 'loadTar', ['list', 'extract', 'ReadEntry']],
          ['vscode-jsonrpc/node', 'loadJsonRpc', ['createMessageConnection', 'StreamMessageReader', 'StreamMessageWriter', 'ResponseError']],
          ['chokidar', 'loadChokidar', ['watch']],
          ['js-yaml', 'loadYaml', ['load', 'YAMLException']],
        ]) {
          blocked = specifier;
          assert.throws(() => core[loader](), error => error === failure);
          blocked = undefined;
          const actual = core[loader]();
          const imported = await import(specifier);
          const expected = specifier === 'chokidar' ? imported.default : imported;
          const repeated = core[loader]();
          for (const name of names) {
            assert.equal(typeof actual[name], 'function', name);
            assert.strictEqual(actual[name], expected[name], name);
            assert.strictEqual(repeated[name], actual[name], name);
          }
        }
        const patch = core.loadDiff().structuredPatch('a', 'a', 'before\\n', 'after\\n');
        assert.deepEqual(patch.hunks[0].lines, ['-before', '+after']);
        const yaml = core.loadYaml();
        assert.deepEqual(yaml.load('enabled: true'), { enabled: true });
        assert.throws(() => yaml.load('enabled: [broken'), yaml.YAMLException);
        hook.deregister();
        console.log('lazy-runtime-package-identity-ok');
      `);
      const result = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("lazy-runtime-package-identity-ok");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
