import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { addMarketplaceOp } from "./marketplace.js";

describe("pinned advert refresh across CLI processes", () => {
  it("claims one deadline before two processes fetch the same failing pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-advert-process-"));
    const pluginStorageRoot = join(root, "plugins");
    const workspaceRoot = join(root, "workspace");
    const market = join(root, "market");
    await mkdir(join(market, ".agenc-plugin"), { recursive: true });
    await mkdir(workspaceRoot);
    await writeFile(join(market, ".agenc-plugin", "marketplace.json"), JSON.stringify({
      metadata: { name: "team" }, plugins: [{ name: "remote",
        source: { source: "git", url: "https://github.com/team/plugins.git", sha: "a".repeat(40) },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" } }],
    }));
    await addMarketplaceOp({ pluginStorageRoot, workspaceRoot, source: market, name: "team" });
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      setTimeout(() => { response.writeHead(404).end(); }, 200);
    });
    try {
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test server port");
      const testDir = dirname(fileURLToPath(import.meta.url));
      const catalogModule = pathToFileURL(resolve(testDir,
        "../../../src/plugins/marketplace/catalog-cli.ts")).href;
      const childScript = `
        import { buildMarketplaceCatalog } from ${JSON.stringify(catalogModule)};
        const [pluginStorageRoot, workspaceRoot, agencHome, port] = process.argv.slice(1);
        const fetcher = async () => fetch('http://127.0.0.1:' + port);
        await buildMarketplaceCatalog({ pluginStorageRoot, workspaceRoot, agencHome, fetcher }, undefined, true);
      `;
      const run = () => new Promise<number>((resolveExit, reject) => {
        const child = spawn(process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", childScript,
            pluginStorageRoot, workspaceRoot, root, String(address.port)],
          { cwd: resolve(testDir, "../../.."), stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
          else resolveExit(code);
        });
      });
      expect(await Promise.all([run(), run()])).toEqual([0, 0]);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 20_000);
});
