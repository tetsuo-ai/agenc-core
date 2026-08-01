import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRedProbeMarkdownLoadHook,
  MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES,
} from "../helpers/red-probe-markdown-loader.mjs";

const temporaryRoots: string[] = [];

function createSourceRoot(): {
  readonly root: string;
  readonly source: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agenc-red-markdown-loader-"));
  temporaryRoots.push(root);
  const source = join(root, "src");
  mkdirSync(source);
  return { root, source };
}

function sourceRootUrl(source: string): string {
  return pathToFileURL(`${source}${sep}`).href;
}

function sha256(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("red-probe markdown loader", () => {
  it("loads one stable in-root asset and records its canonical digest", () => {
    const { source } = createSourceRoot();
    const assetPath = join(source, "prompts", "policy.md");
    mkdirSync(join(source, "prompts"));
    const markdown = "# Trusted fixture\n";
    writeFileSync(assetPath, markdown, { mode: 0o600 });
    const loadedAssets: Array<{ path: string; sha256: string }> = [];
    const nextLoad = vi.fn();
    const load = createRedProbeMarkdownLoadHook({
      runtimeSourceRootUrl: sourceRootUrl(source),
      onAssetLoaded(asset: { path: string; sha256: string }) {
        loadedAssets.push(asset);
      },
    });

    const result = load(pathToFileURL(assetPath).href, {}, nextLoad);

    expect(result).toEqual({
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(markdown)};\n`,
    });
    expect(nextLoad).not.toHaveBeenCalled();
    expect(loadedAssets).toEqual([
      { path: "src/prompts/policy.md", sha256: sha256(markdown) },
    ]);
  });

  it("delegates unknown extensions without inspecting their paths", () => {
    const { source } = createSourceRoot();
    const delegated = Object.freeze({ format: "module" });
    const nextLoad = vi.fn(() => delegated);
    const load = createRedProbeMarkdownLoadHook({
      runtimeSourceRootUrl: sourceRootUrl(source),
      onAssetLoaded: vi.fn(),
    });

    expect(
      load("file:///outside/unknown.txt", { marker: true }, nextLoad),
    ).toBe(delegated);
    expect(load("file:///outside/unknown.MD", { marker: true }, nextLoad)).toBe(
      delegated,
    );
    expect(nextLoad).toHaveBeenCalledTimes(2);
  });

  it("fails closed for markdown outside the exact source root", () => {
    const { root, source } = createSourceRoot();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    const nextLoad = vi.fn();
    const load = createRedProbeMarkdownLoadHook({
      runtimeSourceRootUrl: sourceRootUrl(source),
      onAssetLoaded: vi.fn(),
    });

    expect(() => load(pathToFileURL(outside).href, {}, nextLoad)).toThrow(
      "escapes the runtime source root",
    );
    expect(nextLoad).not.toHaveBeenCalled();
  });

  it("rejects symlinks, oversized bytes, and invalid UTF-8", () => {
    const { root, source } = createSourceRoot();
    const outside = join(root, "outside.md");
    const symlink = join(source, "symlink.md");
    const oversized = join(source, "oversized.md");
    const invalidUtf8 = join(source, "invalid.md");
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    symlinkSync(outside, symlink, "file");
    writeFileSync(
      oversized,
      Buffer.alloc(MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES + 1, 0x78),
      { mode: 0o600 },
    );
    writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    const load = createRedProbeMarkdownLoadHook({
      runtimeSourceRootUrl: sourceRootUrl(source),
      onAssetLoaded: vi.fn(),
    });

    expect(() => load(pathToFileURL(symlink).href, {}, vi.fn())).toThrow(
      "single-link regular file",
    );
    expect(() => load(pathToFileURL(oversized).href, {}, vi.fn())).toThrow(
      `exceeds ${MAXIMUM_RED_PROBE_MARKDOWN_ASSET_BYTES} bytes`,
    );
    expect(() => load(pathToFileURL(invalidUtf8).href, {}, vi.fn())).toThrow(
      "not valid UTF-8",
    );
  });

  it("rejects an asset mutation after descriptor admission", () => {
    const { source } = createSourceRoot();
    const assetPath = join(source, "mutable.md");
    writeFileSync(assetPath, "before\n", { mode: 0o600 });
    const load = createRedProbeMarkdownLoadHook({
      runtimeSourceRootUrl: sourceRootUrl(source),
      onAssetLoaded: vi.fn(),
      afterOpenForTest() {
        writeFileSync(assetPath, "after mutation\n", { mode: 0o600 });
      },
    });

    expect(() => load(pathToFileURL(assetPath).href, {}, vi.fn())).toThrow(
      "changed while it was read",
    );
  });

  it("rejects encoded aliases, URL decorations, and an untrusted root", () => {
    const { root, source } = createSourceRoot();
    const assetPath = join(source, "asset.md");
    writeFileSync(assetPath, "asset\n", { mode: 0o600 });
    const load = createRedProbeMarkdownLoadHook({
      runtimeSourceRootUrl: sourceRootUrl(source),
      onAssetLoaded: vi.fn(),
    });
    const assetUrl = pathToFileURL(assetPath).href;

    expect(() => load(`${assetUrl}?revision=1`, {}, vi.fn())).toThrow(
      "canonical local file URL",
    );
    expect(() =>
      load(assetUrl.replace("/asset.md", "/%2e/asset.md"), {}, vi.fn()),
    ).toThrow("encoded alias");

    const realSource = join(root, "real-source");
    const linkedSource = join(root, "linked-source");
    mkdirSync(realSource);
    symlinkSync(realSource, linkedSource, "dir");
    expect(() =>
      createRedProbeMarkdownLoadHook({
        runtimeSourceRootUrl: sourceRootUrl(linkedSource),
        onAssetLoaded: vi.fn(),
      }),
    ).toThrow("non-symlink directory");
  });
});
