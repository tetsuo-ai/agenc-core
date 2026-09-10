import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeSkillDisplayName, skillDisplayNameFromMarkdown } from "../../src/plugins/skill-display-metadata.js";
import { buildMarketplaceCatalog } from "../../src/plugins/marketplace/catalog-cli.js";
import { addMarketplaceOp } from "../../src/plugins/marketplace/marketplace.js";
import { installPluginOp, listInstalledPlugins } from "../../src/plugins/cli/pluginOperations.js";

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), "agenc-skill-labels-"));
  const agencHome = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  const pluginStorageRoot = join(agencHome, "plugins");
  await Promise.all([agencHome, workspaceRoot, pluginStorageRoot].map(path => mkdir(path, { recursive: true })));
  return { root, agencHome, workspaceRoot, pluginStorageRoot,
    sessionTempRoot: join(root, "sessions"), env: {} };
}

const SHA = "a".repeat(40);
const MANIFEST_URL = `https://raw.githubusercontent.com/example/plugins/${SHA}/plugins/forja/.agenc-plugin/plugin.json`;
const SKILL_URL = `https://raw.githubusercontent.com/example/plugins/${SHA}/plugins/forja/skills/calidad/SKILL.md`;
const LABEL = '---\nname: "Code Quality"\ndescription: Review source code.\n---\n# Code Quality\n';

async function catalogFixture() {
  const options = await runtime();
  const manifest = JSON.stringify({ name: "forja", version: "1.0.0", skills: ["./skills/calidad"] });
  const catalog = JSON.stringify({ name: "labels", plugins: [{ name: "forja",
    source: { source: "git-subdir", url: "https://github.com/example/plugins.git", path: "plugins/forja", sha: SHA },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" } }] });
  const fetcher = vi.fn(async (url: string) => new Response(url === MANIFEST_URL ? manifest : LABEL));
  await addMarketplaceOp({ ...options, source: "https://example.test/catalog.json",
    fetcher: async () => new Response(catalog) });
  const cacheDir = join(options.pluginStorageRoot, "marketplaces", ".logo-cache");
  const key = createHash("sha256").update(MANIFEST_URL).digest("hex").slice(0, 24);
  const cache = join(cacheDir, `${key}.meta.json`);
  const get = async () => (await buildMarketplaceCatalog({ ...options, fetcher }, "desktop")).marketplaces[0]!.plugins[0]!;
  return { ...options, fetcher, get, cache, cacheDir };
}

describe("skill display metadata", () => {
  it("parses English labels without treating body text or non-string values as labels", () => {
    expect(skillDisplayNameFromMarkdown(LABEL)).toBe("Code Quality");
    expect(skillDisplayNameFromMarkdown(LABEL.replaceAll("\n", "\r\n"))).toBe("Code Quality");
    for (const body of ["# Skill\nname: Body text", "---\ndescription: Skill\n---\nname: Body text",
      "---\nname: [invalid\n---\n", "---\nname: [list, value]\n---\n", "---\nname: 12\n---\n",
      '---\nname: ""\n---\n']) expect(skillDisplayNameFromMarkdown(body)).toBeUndefined();
    expect(normalizeSkillDisplayName(`  ${"A".repeat(100)}  `)).toBe("A".repeat(80));
    expect(normalizeSkillDisplayName("bad\u0000label")).toBeUndefined();
  });

  it("carries labels from uninstalled pinned skills into reusable metadata without renaming the skill", async () => {
    const fixture = await catalogFixture();
    const first = await fixture.get();
    expect(first.skills).toEqual([{ name: "calidad", displayName: "Code Quality", description: "Review source code." }]);
    expect(first.source).toMatchObject({ sha: SHA, path: "plugins/forja" });
    expect(fixture.fetcher.mock.calls.map(([url]) => url)).toEqual([MANIFEST_URL, SKILL_URL]);
    const sidecar = JSON.parse(await readFile(fixture.cache, "utf8"));
    expect(sidecar.cardMetadataVersion).toBe(1);
    fixture.fetcher.mockClear();
    expect((await fixture.get()).skills).toEqual(first.skills);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it("refreshes old sidecars at the same SHA, preserving old copy offline until a retry succeeds", async () => {
    const fixture = await catalogFixture();
    await mkdir(fixture.cacheDir, { recursive: true });
    const old = { description: "Cached plugin", skills: [{ name: "calidad", description: "Old copy" }] };
    await writeFile(fixture.cache, JSON.stringify(old));
    fixture.fetcher.mockRejectedValueOnce(new Error("offline"));
    expect((await fixture.get()).skills).toEqual(old.skills);
    expect(JSON.parse(await readFile(fixture.cache, "utf8"))).toEqual(old);
    expect((await fixture.get()).skills).toEqual([{ name: "calidad", displayName: "Code Quality", description: "Review source code." }]);
    expect(JSON.parse(await readFile(fixture.cache, "utf8")).cardMetadataVersion).toBe(1);
  });

  it("does not permanently cache a failed skill fetch as current metadata", async () => {
    const fixture = await catalogFixture();
    fixture.fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ name: "forja", skills: ["./skills/calidad"] })));
    fixture.fetcher.mockRejectedValueOnce(new Error("skill unavailable"));
    expect((await fixture.get()).skills).toEqual([{ name: "calidad" }]);
    expect(JSON.parse(await readFile(fixture.cache, "utf8")).cardMetadataVersion).toBeUndefined();
    expect((await fixture.get()).skills?.[0]?.displayName).toBe("Code Quality");
  });

  it("keeps missing or invalid label fallbacks and bounds cached display values", async () => {
    const fixture = await catalogFixture();
    await mkdir(fixture.cacheDir, { recursive: true });
    await writeFile(fixture.cache, JSON.stringify({ cardMetadataVersion: 1, skills: [
      { name: "calidad", displayName: { forged: true } }, { name: "legacy" },
      { name: "bounded", displayName: "X".repeat(200) },
    ] }));
    expect((await fixture.get()).skills).toEqual([
      { name: "calidad" }, { name: "legacy" }, { name: "bounded", displayName: "X".repeat(80) },
    ]);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it.each([{ skills: "./skills" }, { skills: ["./skills/calidad", "./skills/legacy"] }])("adds installed labels with declaration $skills while preserving identities and paths", async ({ skills }) => {
    const options = await runtime();
    const source = join(options.root, "source");
    await mkdir(join(source, ".agenc-plugin"), { recursive: true });
    await writeFile(join(source, ".agenc-plugin", "plugin.json"), JSON.stringify({ name: "forja", version: "1.0.0", skills }));
    for (const [name, text] of [["calidad", LABEL], ["legacy", "---\ndescription: Legacy skill.\n---\n# Legacy\n"]]) {
      await mkdir(join(source, "skills", name!), { recursive: true });
      await writeFile(join(source, "skills", name!, "SKILL.md"), text!);
    }
    const installed = await installPluginOp({ ...options, source, name: "forja@labels", scope: "user" });
    const result = await listInstalledPlugins(options);
    expect(result.errors).toEqual([]);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({ id: "forja@labels", name: "forja", root: installed.destination,
      skills: [{ name: "calidad", displayName: "Code Quality", description: "Review source code." },
        { name: "legacy", description: "Legacy skill." }] });
  });
});
