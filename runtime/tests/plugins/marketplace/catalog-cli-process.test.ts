import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { addMarketplaceOp } from "./marketplace.js";
import { pluginSignaturePayloadBytes } from "../resolution.js";

async function processMarket(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
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
  return { root, pluginStorageRoot, workspaceRoot };
}

async function signedProcessMarket(prefix: string) {
  const fixture = await processMarket(prefix);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await writeFile(join(fixture.root, "plugin-publishers.json"), JSON.stringify({ publishers: {
    team: { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") },
  } }));
  const manifest = Buffer.from(JSON.stringify({ name: "remote", version: "2.0.0" }));
  await writeFile(join(fixture.root, "manifest.json"), manifest);
  await writeFile(join(fixture.root, "signature.json"), JSON.stringify({ publisher: "team", files: {},
    signature: sign(null, pluginSignaturePayloadBytes(manifest, {}), privateKey).toString("base64"),
  }));
  return fixture;
}

describe("pinned advert refresh across CLI processes", () => {
  it("keeps a verified update visible to later CLI processes", async () => {
    const { root, pluginStorageRoot, workspaceRoot } =
      await signedProcessMarket("agenc-signed-advert-process-");
    const testDir = dirname(fileURLToPath(import.meta.url));
    const catalogModule = pathToFileURL(resolve(testDir,
      "../../../src/plugins/marketplace/catalog-cli.ts")).href;
    const cliModule = pathToFileURL(resolve(testDir,
      "../../../src/plugins/cli/pluginCliCommands.ts")).href;
    const childScript = `
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { buildMarketplaceCatalog } from ${JSON.stringify(catalogModule)};
      import { pluginListWithCatalog } from ${JSON.stringify(cliModule)};
      const [pluginStorageRoot, workspaceRoot, agencHome] = process.argv.slice(1);
      const fetcher = async (url) => new Response(await readFile(join(agencHome,
        url.endsWith('/plugin.json') ? 'manifest.json' : 'signature.json')));
      const result = await buildMarketplaceCatalog({ pluginStorageRoot, workspaceRoot, agencHome,
        fetcher }, undefined, true);
      const compared = pluginListWithCatalog({ plugins: [{ id: 'remote@team', name: 'remote',
        version: '1.0.0', enabled: true, root: '/installed', source: 'remote@team',
        sourceKind: 'marketplace', marketplace: 'team', verificationState: 'verified',
        sourceLocation: 'https://github.com/team/plugins.git',
        payloadDigest: 'sha256:old' }], errors: [] }, result).plugins[0];
      process.stdout.write(JSON.stringify({ digest: result.marketplaces[0]?.plugins[0]?.payloadDigest,
        updateAvailable: compared.updateAvailable,
        updateVerificationState: compared.updateVerificationState }));
    `;
    const run = () => new Promise<{ digest: string; updateAvailable: boolean; updateVerificationState: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", childScript,
          pluginStorageRoot, workspaceRoot, root],
        { cwd: resolve(testDir, "../../.."), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolveResult(JSON.parse(stdout)) :
        reject(new Error(stderr || `child exited ${code}`)));
    });
    const first = await run();
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first).toMatchObject({ updateAvailable: true, updateVerificationState: "verified" });
    expect(await run()).toEqual(first);
    expect(await run()).toEqual(first);
  }, 20_000);

  it("claims one deadline before two processes fetch the same failing pin", async () => {
    const { root, pluginStorageRoot, workspaceRoot } =
      await processMarket("agenc-advert-process-");
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

  it("claims one recovery fetch across processes after the binding key disappears", async () => {
    const { root, pluginStorageRoot, workspaceRoot } =
      await signedProcessMarket("agenc-advert-recovery-process-");
    const testDir = dirname(fileURLToPath(import.meta.url));
    const catalogModule = pathToFileURL(resolve(testDir,
      "../../../src/plugins/marketplace/catalog-cli.ts")).href;
    const childScript = `
      import { appendFile, readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { buildMarketplaceCatalog } from ${JSON.stringify(catalogModule)};
      const [pluginStorageRoot, workspaceRoot, agencHome, mode] = process.argv.slice(1);
      const fetcher = async (url) => {
        if (mode === 'offline') {
          if (url.endsWith('/plugin.json')) await appendFile(join(agencHome, 'attempts'), 'manifest\\n');
          throw new Error('offline');
        }
        return new Response(await readFile(join(agencHome,
          url.endsWith('/plugin.json') ? 'manifest.json' : 'signature.json')));
      };
      await buildMarketplaceCatalog({ pluginStorageRoot, workspaceRoot, agencHome,
        fetcher }, undefined, true);
    `;
    const run = (mode: "online" | "offline") => new Promise<void>((resolveExit, reject) => {
      const child = spawn(process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", childScript,
          pluginStorageRoot, workspaceRoot, root, mode],
        { cwd: resolve(testDir, "../../.."), stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolveExit() :
        reject(new Error(stderr || `child exited ${code}`)));
    });
    await run("online");
    await rm(join(root, "private", "plugin-adverts", "binding-key"));
    await Promise.all([run("offline"), run("offline")]);
    expect((await readFile(join(root, "attempts"), "utf8")).trim().split("\n")).toEqual(["manifest"]);
  }, 20_000);
});
