import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import config from "../../build.config.js";

describe("production Zod package identity", () => {
  it("shares root, v3 and v4 constructors and registry with external consumers", async () => {
    const temp = await mkdtemp(join(process.cwd(), ".zod-identity-"));
    try {
      const fixture = join(temp, "fixture.mjs");
      await writeFile(fixture, `
        import { z as root } from 'zod';
        import { z as v3 } from 'zod/v3';
        import { z as v4 } from 'zod/v4';
        export { root, v3, v4 };
        export const schema = v4.object({ permission: v4.enum(['allow', 'deny']) }).strict();
      `);
      const result = await build({
        entryPoints: [fixture], outfile: join(temp, "built.mjs"),
        bundle: true, platform: "node", format: "esm", metafile: true,
        external: config.external.flatMap(name => [name, `${name}/*`]),
      });
      expect(Object.keys(result.metafile!.inputs).some(path => /node_modules\/zod\//.test(path))).toBe(false);
      const control = join(temp, "control.mjs");
      await writeFile(control, `
        import assert from 'node:assert/strict';
        import { z as root } from 'zod';
        import { z as v3 } from 'zod/v3';
        import { z as v4 } from 'zod/v4';
        import * as built from './built.mjs';
        assert.strictEqual(built.root, root);
        assert.strictEqual(built.v3, v3);
        assert.strictEqual(built.v4, v4);
        for (const [local, external] of [[built.root, root], [built.v3, v3], [built.v4, v4]]) {
          assert.strictEqual(local.ZodError, external.ZodError);
          assert.strictEqual(local.ZodObject.prototype, external.ZodObject.prototype);
          const invalid = local.string().safeParse(123);
          assert.equal(invalid.success, false);
          assert(invalid.error instanceof external.ZodError);
        }
        assert.deepEqual(built.schema.parse({ permission: 'deny' }), { permission: 'deny' });
        assert.equal(built.schema.safeParse({ permission: 'allow', untrusted: true }).success, false);
        assert.deepEqual(await built.schema.parseAsync({ permission: 'allow' }), { permission: 'allow' });
        const metadata = { id: 'agenc-shared-zod-identity' };
        const registered = built.schema.meta(metadata);
        assert.deepEqual(v4.globalRegistry.get(registered), metadata);
        v4.globalRegistry.remove(registered);
        const previous = v4.config();
        try {
          v4.config({ customError: () => 'shared error policy' });
          assert.equal(built.schema.safeParse(null).error.issues[0].message, 'shared error policy');
        } finally { v4.config({ ...previous, customError: previous.customError }); }
        console.log('zod-package-identity-ok');
      `);
      const run = spawnSync(process.execPath, [control], { encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe("zod-package-identity-ok");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
