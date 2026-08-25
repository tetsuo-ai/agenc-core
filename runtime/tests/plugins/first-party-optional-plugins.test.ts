import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { loadMarketplace } from "../../src/plugins/marketplace/marketplace.js";
import {
  validateMarketplaceManifest,
  validatePluginManifest,
} from "../../src/plugins/validation.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OPTIONAL_PLUGIN_NAMES = [
  "iot-builder",
  "ledger-wallet-cli",
  "zeroday-hunter",
] as const;

describe("first-party optional plugins", () => {
  test("validates all plugin manifests and the remotely servable catalog", async () => {
    for (const name of OPTIONAL_PLUGIN_NAMES) {
      const result = await validatePluginManifest(
        join(REPO_ROOT, "plugins", name, ".agenc-plugin", "plugin.json"),
      );
      expect(result, `${name}: ${JSON.stringify(result.errors)}`).toMatchObject({
        success: true,
        errors: [],
      });
    }

    const catalogPath = join(REPO_ROOT, "marketplace.json");
    const validation = await validateMarketplaceManifest(catalogPath);
    expect(validation).toMatchObject({ success: true, errors: [] });
    const catalog = await loadMarketplace(catalogPath);
    expect(catalog.name).toBe("agenc-first-party");
    expect(catalog.plugins.map((plugin) => plugin.name)).toEqual([
      "iot-builder",
      "ledger-wallet-cli",
      "zeroday-hunter",
    ]);
    for (const plugin of catalog.plugins) {
      expect(plugin.policy.installation).toBe("AVAILABLE");
      expect(plugin.policy.installation).not.toBe("INSTALLED_BY_DEFAULT");
      expect(plugin.policy.products).toEqual(["desktop"]);
      expect(plugin.version).toBe("0.1.0");
      expect(plugin.description).toEqual(expect.any(String));
      expect(plugin.components).toContain("skills");
      expect(plugin.interface).toMatchObject({
        displayName: expect.any(String),
        shortDescription: expect.any(String),
        longDescription: expect.any(String),
        developerName: "Tetsuo AI",
        category: expect.any(String),
        capabilities: expect.arrayContaining(["skills"]),
        brandColor: expect.stringMatching(/^#[0-9A-F]{6}$/u),
        screenshots: [],
      });
      expect(plugin.source).toMatchObject({
        type: "local",
        path: join(REPO_ROOT, "plugins", plugin.name),
      });
    }
  });

  test("keeps optional plugin code out of the clean runtime bundle", async () => {
    const [bundled, tools, registry, gatewayContext, packageJson] = await Promise.all([
      readFile(join(REPO_ROOT, "runtime", "src", "skills", "bundledSkills.ts"), "utf8"),
      readFile(join(REPO_ROOT, "runtime", "src", "bin", "model-facing-tools.ts"), "utf8"),
      readFile(join(REPO_ROOT, "runtime", "src", "commands", "registry.ts"), "utf8"),
      readFile(join(REPO_ROOT, "runtime", "src", "gateway", "untrusted.ts"), "utf8"),
      readFile(join(REPO_ROOT, "runtime", "package.json"), "utf8"),
    ]);
    expect(bundled).not.toContain("iot-builder");
    expect(tools).not.toContain("ledger_wallet_cli");
    expect(registry).not.toContain("ledgerCommand");
    expect(gatewayContext).not.toContain("AgenC Ledger integration");
    expect(packageJson).not.toContain("sync-shipped-plugins");
    expect(JSON.parse(packageJson)).not.toHaveProperty("files", expect.arrayContaining(["plugins"]));
    await expect(stat(join(REPO_ROOT, "runtime", "assets", "ledger-nano.svg")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(REPO_ROOT, "runtime", "scripts", "generate-ledger-nano-graphics.mjs")))
      .rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      stat(
        join(
          REPO_ROOT,
          "runtime",
          "src",
          "elicitation",
          "request-ledger-transfer.ts",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const runtimeSourceRoot = join(REPO_ROOT, "runtime", "src");
    const runtimeSourceFiles = (await readdir(runtimeSourceRoot, {
      recursive: true,
    })).filter((path) => /\.(?:ts|tsx)$/u.test(path));
    for (const relativePath of runtimeSourceFiles) {
      const source = await readFile(join(runtimeSourceRoot, relativePath), "utf8");
      expect(`${relativePath}\n${source}`).not.toMatch(
        /@ledger|request_ledger_transfer|ledger_solana_transfer|portal\.ledger\.solana/iu,
      );
    }
  });

  test("keeps optional skill references resolvable after plugin installation", async () => {
    const iotSkill = join(
      REPO_ROOT,
      "plugins",
      "iot-builder",
      "skills",
      "iot-builder",
      "SKILL.md",
    );
    const iotText = await readFile(iotSkill, "utf8");
    const iotReferences = [...iotText.matchAll(
      /\breferences\/(?:boards|toolchains|workflows)\/[a-z0-9-]+\.md\b|\breferences\/safety\.md\b/gu,
    )].map((match) => match[0]);
    expect(iotReferences.length).toBeGreaterThan(10);
    for (const relativePath of new Set(iotReferences)) {
      await expect(stat(join(dirname(iotSkill), relativePath))).resolves.toMatchObject({
        size: expect.any(Number),
      });
    }
    expect(iotText).not.toMatch(
      /(?<!references\/)(?:boards|toolchains|workflows)\/[a-z0-9-]+\.md\b/gu,
    );

    const hunterSkill = join(
      REPO_ROOT,
      "plugins",
      "zeroday-hunter",
      "skills",
      "zeroday-hunter",
      "SKILL.md",
    );
    const hunterText = await readFile(hunterSkill, "utf8");
    const pluginAssets = [...hunterText.matchAll(
      /\.\.\/\.\.\/(?:scripts\/[a-z0-9-]+\.sh|templates\/[a-z0-9-]+\.md)/gu,
    )].map((match) => match[0]);
    expect(new Set(pluginAssets)).toEqual(new Set([
      "../../scripts/campaign.sh",
      "../../scripts/poc-check.sh",
      "../../scripts/zdh-init.sh",
      "../../scripts/zdh-slice.sh",
      "../../scripts/zdh-triage.sh",
      "../../scripts/zdh-variant.sh",
      "../../scripts/zdh-watch.sh",
      "../../templates/finding.md",
    ]));
    for (const relativePath of new Set(pluginAssets)) {
      await expect(stat(resolve(dirname(hunterSkill), relativePath))).resolves.toMatchObject({
        size: expect.any(Number),
      });
    }
  });

  test("Wallet CLI MCP exposes only the packaged strict harness and workflows", async () => {
    const serverPath = join(
      REPO_ROOT,
      "plugins",
      "ledger-wallet-cli",
      "mcp",
      "ledger-wallet-cli-server.mjs",
    );
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout! });
    const iterator = lines[Symbol.asyncIterator]();
    const request = async (id: number, method: string, params?: unknown) => {
      child.stdin!.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      })}\n`);
      const next = await iterator.next();
      if (next.done) throw new Error("Wallet CLI MCP server closed before replying");
      return JSON.parse(next.value) as Record<string, any>;
    };

    try {
      const initialized = await request(1, "initialize", {
        protocolVersion: "2025-06-18",
      });
      expect(initialized.result).toMatchObject({
        serverInfo: { name: "ledger-wallet-cli", version: "0.1.0" },
      });
      const listed = await request(2, "tools/list");
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "ledger_wallet_cli_run",
        "ledger_wallet_cli_workflow",
      ]);

      // The harness rejects an unknown dry-run typo before looking for a
      // wallet or touching a device, which prevents a typo becoming a send.
      const rejected = await request(3, "tools/call", {
        name: "ledger_wallet_cli_run",
        arguments: {
          args: [
            "send",
            "solana-1",
            "--to",
            "11111111111111111111111111111111",
            "--amount",
            "1 SOL",
            "--dry-rnu",
          ],
        },
      });
      expect(rejected.result.isError).toBe(true);
      expect(rejected.result.content[0].text).toContain(
        "Unknown or unsupported flag for `send`: --dry-rnu",
      );
    } finally {
      lines.close();
      child.kill("SIGTERM");
    }
  });
});
