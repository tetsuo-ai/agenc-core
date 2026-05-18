import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getWikiPaths,
  getWikiStatus,
  handleWikiCommand,
  initializeWiki,
  wikiCommand,
} from "./wiki.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "agenc-wiki-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getWikiPaths", () => {
  it("places the wiki under <cwd>/.agenc/wiki", () => {
    const paths = getWikiPaths("/tmp/proj");
    expect(paths.root).toBe("/tmp/proj/.agenc/wiki");
    expect(paths.pagesDir).toBe("/tmp/proj/.agenc/wiki/pages");
    expect(paths.sourcesDir).toBe("/tmp/proj/.agenc/wiki/sources");
    expect(paths.schemaFile).toMatch(/schema\.md$/);
    expect(paths.indexFile).toMatch(/index\.md$/);
    expect(paths.logFile).toMatch(/log\.md$/);
  });
});

describe("getWikiStatus", () => {
  it("reports uninitialized when nothing exists yet", async () => {
    const status = await getWikiStatus(tmpRoot);
    expect(status.initialized).toBe(false);
    expect(status.pageCount).toBe(0);
    expect(status.sourceCount).toBe(0);
    expect(status.hasSchema).toBe(false);
    expect(status.hasIndex).toBe(false);
    expect(status.hasLog).toBe(false);
  });

  it("reports initialized after initializeWiki runs", async () => {
    await initializeWiki(tmpRoot);
    const status = await getWikiStatus(tmpRoot);
    expect(status.initialized).toBe(true);
    expect(status.hasSchema).toBe(true);
    expect(status.hasIndex).toBe(true);
    expect(status.hasLog).toBe(true);
  });
});

describe("initializeWiki", () => {
  it("creates schema/index/log on first run", async () => {
    const result = await initializeWiki(tmpRoot);
    expect(result.alreadyExisted).toBe(false);
    expect(result.createdFiles.length).toBeGreaterThan(0);
    expect(result.createdFiles.some((p) => p.endsWith("schema.md"))).toBe(true);
    expect(result.createdFiles.some((p) => p.endsWith("index.md"))).toBe(true);
  });

  it("is idempotent — running twice does not recreate files", async () => {
    await initializeWiki(tmpRoot);
    const second = await initializeWiki(tmpRoot);
    expect(second.createdFiles).toEqual([]);
  });
});

describe("handleWikiCommand", () => {
  it("default + status both return the wiki status text", async () => {
    const text = await handleWikiCommand(tmpRoot, "");
    expect(text).toContain("AgenC wiki");
    const status = await handleWikiCommand(tmpRoot, "status");
    expect(status).toContain("AgenC wiki");
  });

  it("'help' returns the help message", async () => {
    const text = await handleWikiCommand(tmpRoot, "help");
    expect(text.toLowerCase()).toContain("usage");
    expect(text).toContain("init");
    expect(text).toContain("ingest");
  });

  it("'init' creates the wiki tree", async () => {
    const text = await handleWikiCommand(tmpRoot, "init");
    expect(text.toLowerCase()).toContain("created");
    expect((await getWikiStatus(tmpRoot)).initialized).toBe(true);
  });

  it("'ingest' without a path returns usage hint", async () => {
    const text = await handleWikiCommand(tmpRoot, "ingest");
    expect(text).toContain("Usage: /wiki ingest");
  });

  it("'ingest <path>' summarizes a markdown source", async () => {
    await initializeWiki(tmpRoot);
    const sourcePath = path.join(tmpRoot, "src.md");
    writeFileSync(
      sourcePath,
      "# AgenC Notes\n\nKey ideas about the AgenC runtime go here.\n",
      "utf8",
    );
    const text = await handleWikiCommand(tmpRoot, `ingest ${sourcePath}`);
    expect(text).toContain("AgenC Notes");
  });

  it("unknown subcommand returns help", async () => {
    const text = await handleWikiCommand(tmpRoot, "fizzle");
    expect(text).toContain("Unknown wiki subcommand");
    expect(text).toContain("Usage");
  });
});

describe("wikiCommand.execute", () => {
  it("returns a text result", async () => {
    const result = await wikiCommand.execute({
      session: {} as never,
      argsRaw: "status",
      cwd: tmpRoot,
      home: "/tmp/home",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("AgenC wiki");
    }
  });
});
