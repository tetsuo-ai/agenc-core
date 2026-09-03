/**
 * Regression tests for issue #1794: MCP content providers must serve skill
 * prompts and resource bodies from a location proven against a retained root
 * descriptor, never from a pathname resolved a second time.
 *
 * Most tests here are *mutation* tests: each is written so that deleting the
 * single guard named in its title makes it fail. A guard whose deletion leaves
 * the suite green is not covered, however many tests surround it.
 *
 * Some guards are not individually killable, and saying so is part of the
 * record rather than a gap to paper over:
 *
 *   - `O_NOFOLLOW` has no behavioural mutant at all. It is pinned on the flag
 *     value in `tests/fs/verified-read.test.ts`, with the reason.
 *   - `nlink === 1n` is checked in three places (listing admission, the open
 *     in `openVerifiedCandidate`, and the opened handle in
 *     `readScopedRegularFile`). Deleting any one leaves the suite green; only
 *     deleting all three fails it. They are pinned collectively.
 *   - the root symlink pre-check in `bindVerifiedRoot` is only killable
 *     together with `O_DIRECTORY`/`O_NOFOLLOW` on the root open.
 *   - the `isContained` pre-check in `openVerifiedCandidate` is redundant with
 *     the ancestor walk's canonical containment for every reachable escape.
 *
 * Two tests here used to pass for the wrong reason and now do not: the
 * pre-open ancestor walk (see "at the open boundary") stayed green when it was
 * deleted, because the test's own restore step moved the bound root's
 * timestamps and the POST-read walk rejected instead; and the same-inode
 * symlink test named a proof that never runs.
 */
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { enterCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

import {
  MAX_SCOPED_FILE_BYTES,
  MAX_SCOPED_INSTRUCTION_FILE_BYTES,
  createMemoryResourceProvider,
  createSkillPromptProvider,
  type MemoryResourceProviderOptions,
  type ScopedReadRejection,
} from "../../src/mcp/server/content-providers.js";

const SECRET = "PRIVATE SESSION TRANSCRIPT ak_1794_secret";
const SECRET_TOKEN = "ghp_1794567890abcdefABCDEF1234567890abcdef";
const FORGED = "FORGED-OUT-OF-SCOPE";

const roots: string[] = [];
let root: string;
let rejections: ScopedReadRejection[];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-mcp-verified-")));
  roots.push(root);
  rejections = [];
  vi.stubEnv("AGENC_HOME", root);
  enterCanonicalSettingsAuthority(new ConfigStore({
    home: root,
    env: { ...process.env, AGENC_HOME: root },
    cwd: root,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function reasons(): string[] {
  return rejections.map((rejection) => rejection.reason);
}

function makeSkill(name: string, body: string): string {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(
    file,
    ["---", `description: ${name} skill`, "---", body].join("\n"),
  );
  return file;
}

function makeOutsideDir(): string {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agenc-mcp-outside-")));
  roots.push(outside);
  return outside;
}

function makeOutsideSecret(name: string): string {
  const file = join(makeOutsideDir(), name);
  writeFileSync(
    file,
    ["---", `description: ${name}`, "---", SECRET, SECRET_TOKEN].join("\n"),
  );
  return file;
}

function makeMemoryFile(name: string, body: string): string {
  mkdirSync(join(root, "memory"), { recursive: true });
  const file = join(root, "memory", name);
  writeFileSync(
    file,
    ["---", `name: ${name.replace(/\.md$/, "")}`, `description: ${name}`, "---", body].join("\n"),
  );
  return file;
}

/**
 * `mkfifo` is asserted here, in the test body, and never inside a reader hook:
 * a hook throws *into* the reader's own try/catch, where the failure becomes
 * the same `null` the test asserts on and the test passes without ever having
 * built a FIFO.
 */
function makeFifo(path: string): void {
  const result = spawnSync("mkfifo", [path]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
}

function skillProvider(
  overrides: {
    skillRoots?: readonly string[];
    scopeRoot?: string;
    beforeOpenForTesting?: (path: string) => void;
    beforeReadForTesting?: (path: string) => void;
    beforeHeaderReadForTesting?: (path: string) => void;
  } = {},
) {
  return createSkillPromptProvider({
    skillRoots: [join(root, "skills")],
    scopeRoot: root,
    onRejected: (rejection) => rejections.push(rejection),
    ...overrides,
  });
}

function resourceProvider(
  overrides: Partial<MemoryResourceProviderOptions> = {},
) {
  return createMemoryResourceProvider({
    memoryDirs: [join(root, "memory")],
    scopeRoot: root,
    onRejected: (rejection) => rejections.push(rejection),
    ...overrides,
  });
}

describe("verified skill prompt reads", () => {
  test("serves a plain in-scope skill", async () => {
    makeSkill("plain", "safe body");
    const provider = skillProvider();
    const prompts = await provider.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("plain");
    const prompt = await provider.getPrompt("plain");
    expect(prompt?.messages[0]).toMatchObject({
      role: "user",
      content: { type: "text", text: expect.stringContaining("safe body") },
    });
  });

  test("omits a skill swapped for a symlink after validation", async () => {
    const file = makeSkill("swapped", "safe body");
    const secret = makeOutsideSecret("secret.md");
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        rmSync(file);
        symlinkSync(secret, file);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
    expect(await provider.getPrompt("swapped")).toBeNull();
  });

  test("omits a skill swapped for a same-inode symlink: the pre-open symlink check rejects it", async () => {
    const file = makeSkill("selflink", "safe body");
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        // The replacement symlink resolves to the very inode validation saw.
        // Instrumenting both branches shows which clause actually fires: the
        // `lstat(...).isSymbolicLink()` check inside `openVerifiedCandidate`,
        // before the open. The identity proof would also reject it — creating
        // the second name moves the inode's ctime — but it never runs, so
        // this test does not pin it and the title no longer says it does.
        const alias = `${file}.same-inode`;
        linkSync(file, alias);
        rmSync(file);
        symlinkSync(alias, file);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
  });

  test("omits a skill replaced by another regular file after validation", async () => {
    const file = makeSkill("replaced", "safe body");
    const attacker = join(root, "attacker.md");
    writeFileSync(attacker, "attacker body", "utf8");
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        renameSync(attacker, file);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
  });

  test("omits a skill whose ancestor directory is swapped for a symlink after validation", async () => {
    const file = makeSkill("ancestor", "safe body");
    const outsideDir = makeOutsideDir();
    writeFileSync(
      join(outsideDir, "SKILL.md"),
      ["---", `description: ${FORGED}`, "---", SECRET].join("\n"),
    );
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        const dir = join(root, "skills", "ancestor");
        renameSync(dir, `${dir}.moved`);
        symlinkSync(outsideDir, dir);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
    expect(await provider.getPrompt("ancestor")).toBeNull();
  });

  test("omits a skill whose open file is replaced before the read", async () => {
    const file = makeSkill("midread", "safe body");
    const attacker = join(root, "midread-attacker.md");
    writeFileSync(attacker, "attacker body", "utf8");
    const provider = skillProvider({
      beforeReadForTesting: (path) => {
        if (path !== file) return;
        renameSync(attacker, file);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
  });

  test("omits a skill mutated in place after the open", async () => {
    const file = makeSkill("mutated", "safe body");
    const provider = skillProvider({
      beforeReadForTesting: (path) => {
        if (path !== file) return;
        writeFileSync(file, "mutated body!", "utf8");
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
  });

  test("omits multiply linked skill files", async () => {
    const secret = makeOutsideSecret("session.md");
    const dir = join(root, "skills", "leak");
    mkdirSync(dir, { recursive: true });
    linkSync(secret, join(dir, "SKILL.md"));
    const provider = skillProvider();
    expect(await provider.listPrompts()).toEqual([]);
    expect(await provider.getPrompt("leak")).toBeNull();
  });

  test("omits oversized skill files", async () => {
    const dir = join(root, "skills", "huge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      Buffer.alloc(MAX_SCOPED_FILE_BYTES + 1, 0x61),
    );
    const provider = skillProvider();
    expect(await provider.listPrompts()).toEqual([]);
    expect(reasons()).toContain("too_large");
  });

  test.runIf(process.platform !== "win32")(
    "omits a skill replaced by a FIFO after validation without blocking",
    async () => {
      const file = makeSkill("fifod", "safe body");
      const fifo = join(root, "skills", "fifod", "swap-in.fifo");
      makeFifo(fifo);
      const provider = skillProvider({
        beforeOpenForTesting: (path) => {
          if (path !== file) return;
          rmSync(file);
          renameSync(fifo, file);
        },
      });
      expect(await provider.listPrompts()).toEqual([]);
    },
  );
});

/**
 * GUARD: the `scopeRoot` containment check in `bindScopedRoot`.
 * Deleting it makes both tests below serve out-of-scope bodies.
 */
describe("scope-root containment", () => {
  test("omits a skill root whose canonical path escapes the scope root", async () => {
    const outside = makeOutsideDir();
    const escapedSkills = join(outside, "skills");
    mkdirSync(join(escapedSkills, "escaped"), { recursive: true });
    writeFileSync(
      join(escapedSkills, "escaped", "SKILL.md"),
      ["---", `description: ${FORGED}`, "---", SECRET].join("\n"),
    );
    // The requested path is inside the scope root and is a real directory;
    // only its canonical resolution is outside, because an ancestor is a
    // symlink. Nothing about the name gives that away.
    symlinkSync(outside, join(root, "linked"));
    const provider = skillProvider({
      skillRoots: [join(root, "linked", "skills")],
    });
    expect(await provider.listPrompts()).toEqual([]);
    expect(await provider.getPrompt("escaped")).toBeNull();
    expect(reasons()).toContain("root_outside_scope");
  });

  test("omits an instruction file whose parent escapes the scope root", async () => {
    const outside = makeOutsideDir();
    mkdirSync(join(outside, "project"), { recursive: true });
    writeFileSync(
      join(outside, "project", "AGENC.md"),
      `# escaped instructions\n${SECRET}`,
    );
    symlinkSync(outside, join(root, "linked"));
    const provider = resourceProvider({
      memoryDirs: [],
      instructionFiles: [join(root, "linked", "project", "AGENC.md")],
    });
    expect(await provider.listResources()).toEqual([]);
    expect(reasons()).toContain("root_outside_scope");
  });

  test("omits a skill root that is itself a symlink", async () => {
    const outside = makeOutsideDir();
    mkdirSync(join(outside, "escaped"), { recursive: true });
    writeFileSync(
      join(outside, "escaped", "SKILL.md"),
      ["---", `description: ${FORGED}`, "---", SECRET].join("\n"),
    );
    symlinkSync(outside, join(root, "skills"));
    const provider = skillProvider();
    expect(await provider.listPrompts()).toEqual([]);
  });
});

/**
 * GUARD: `verifyParentChain`, before the open and again after the read.
 *
 * Both tests replace one ancestor with a symlink that resolves to the very
 * directory it replaced, so the candidate's inode, size, and timestamps are
 * untouched: every identity proof still passes and only the ancestor walk can
 * tell the difference. That is the check the escape in #1794 defeated.
 */
describe("descriptor-bound ancestor containment", () => {
  function selfSymlinkAncestor(name: string): void {
    const dir = join(root, "skills", name);
    renameSync(dir, `${dir}.real`);
    symlinkSync(`${name}.real`, dir);
  }

  function restoreAncestor(name: string): void {
    const dir = join(root, "skills", name);
    unlinkSync(dir);
    renameSync(`${dir}.real`, dir);
  }

  test("omits a skill whose ancestor is a symlink at the open boundary", async () => {
    const file = makeSkill("preopen", "safe body");
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        selfSymlinkAncestor("preopen");
      },
      beforeReadForTesting: (path) => {
        // Reached only when the pre-open walk is gone. Restoring here puts the
        // ancestor back before the post-read walk looks, so the post-read walk
        // cannot stand in for the deleted one and the mutant serves bytes
        // taken through an unvetted ancestor.
        if (path !== file) return;
        restoreAncestor("preopen");
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
    // Naming the reason is what makes this isolating. The restore moves the
    // bound skills root's mtime and ctime; while the directory re-proof still
    // compared those, the POST-read walk rejected on the restore alone and
    // this test stayed green with the pre-open walk deleted. The directory
    // re-proof is now dev/ino/mode, so a moved timestamp is not a rejection
    // and `ancestor_changed` here would mean the wrong walk did the work.
    expect(reasons()).toContain("verification_failed");
    expect(reasons()).not.toContain("ancestor_changed");
  });

  test("omits a skill whose ancestor becomes a symlink after the bytes are read", async () => {
    const file = makeSkill("postread", "safe body");
    const provider = skillProvider({
      beforeReadForTesting: (path) => {
        if (path !== file) return;
        selfSymlinkAncestor("postread");
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
    expect(reasons()).toContain("ancestor_changed");
  });

  /**
   * GUARD: the path side of `assertCandidateUnchanged`.
   *
   * Isolating it takes a nested candidate. Exchanging the *directory* that
   * holds the file leaves the open inode completely untouched — no unlink, no
   * ctime move — so the handle-side check passes; and because the exchanged
   * directory is an intermediate ancestor rather than the bound root, the
   * ancestor walk passes too: it sees a real, contained, non-symlink
   * directory and the root's own identity has not moved. Only comparing the
   * path's object against the one that was read notices that the name now
   * leads somewhere else.
   */
  test("fails a nested resource read whose directory is exchanged after the read", async () => {
    const nested = join(root, "memory", "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "notes.md"),
      ["---", "name: notes", "description: nested notes", "---", "safe body"].join("\n"),
    );
    const decoy = join(root, "decoy");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, "notes.md"),
      ["---", "name: notes", "description: decoy", "---", "decoy body"].join("\n"),
    );
    const provider = resourceProvider();
    const listed = await provider.listResources();
    const target = listed.find((r) => r.name.endsWith("notes.md"))!;
    expect(target).toBeDefined();
    const file = join(root, "memory", "a", "b", "notes.md");
    const swapped = resourceProvider({
      beforeReadForTesting: (path) => {
        if (path !== file) return;
        renameSync(nested, join(root, "b.away"));
        renameSync(decoy, nested);
      },
    });
    expect(await swapped.readResource(target.uri)).toBeNull();
  });
});

/**
 * GUARD: the `isFile()` clause of `admitsScopedSnapshot`.
 *
 * A FIFO is the case that isolates it: it is not a symlink, has one link, and
 * has size 0, so every other clause admits it. Without `isFile()` the listing
 * advertises a resource whose read would block or fail.
 */
describe("regular-file admission", () => {
  test.runIf(process.platform !== "win32")(
    "does not list an instruction path that is a FIFO",
    async () => {
      const fifo = join(root, "AGENC.md");
      makeFifo(fifo);
      const provider = resourceProvider({
        memoryDirs: [],
        instructionFiles: [fifo],
      });
      expect(await provider.listResources()).toEqual([]);
      expect(reasons()).toContain("not_admissible");
    },
  );

  test("does not list an instruction path that is a directory", async () => {
    mkdirSync(join(root, "AGENC.md"), { recursive: true });
    const provider = resourceProvider({
      memoryDirs: [],
      instructionFiles: [join(root, "AGENC.md")],
    });
    expect(await provider.listResources()).toEqual([]);
  });
});

/**
 * GUARD: the byte ceilings, and the fact that the instruction ceiling is the
 * same number the runtime uses for the same file in-process.
 */
describe("byte ceilings", () => {
  test("serves an instruction file larger than the skill ceiling", async () => {
    const body = `# big instructions\n${"a".repeat(2 * 1024 * 1024)}`;
    expect(body.length).toBeGreaterThan(MAX_SCOPED_FILE_BYTES);
    expect(body.length).toBeLessThan(MAX_SCOPED_INSTRUCTION_FILE_BYTES);
    writeFileSync(join(root, "AGENC.md"), body);
    const provider = resourceProvider({
      memoryDirs: [],
      instructionFiles: [join(root, "AGENC.md")],
    });
    const resources = await provider.listResources();
    expect(resources.map((r) => r.name)).toContain("AGENC.md");
    const read = await provider.readResource(resources[0]!.uri);
    expect(read?.contents[0].text).toContain("# big instructions");
  });

  test("omits an instruction file past the shared in-process ceiling", async () => {
    writeFileSync(
      join(root, "AGENC.md"),
      Buffer.alloc(MAX_SCOPED_INSTRUCTION_FILE_BYTES + 1, 0x61),
    );
    const provider = resourceProvider({
      memoryDirs: [],
      instructionFiles: [join(root, "AGENC.md")],
    });
    expect(await provider.listResources()).toEqual([]);
    expect(reasons()).toContain("too_large");
  });
});

/**
 * GUARD: the fatal UTF-8 decode. `Buffer#toString("utf8")` substitutes U+FFFD,
 * which hands the client a body that is not the file and lets invalid bytes
 * reshape frontmatter.
 */
describe("fatal UTF-8 decoding", () => {
  test("omits a skill whose bytes are not valid UTF-8", async () => {
    const dir = join(root, "skills", "binary");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      Buffer.concat([
        Buffer.from("---\ndescription: binary\n---\n", "utf8"),
        Buffer.from([0xff, 0xfe, 0x80]),
      ]),
    );
    const provider = skillProvider();
    expect(await provider.listPrompts()).toEqual([]);
    expect(reasons()).toContain("invalid_utf8");
  });

  test("fails a resource read whose bytes are not valid UTF-8", async () => {
    // The invalid bytes sit past the 64 KiB header prefix the memory scanner
    // decodes, so the file still lists; only the full body read sees them.
    makeMemoryFile("notes.md", "placeholder");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(
      join(root, "memory", "notes.md"),
      Buffer.concat([
        Buffer.from(
          `---\nname: notes\ndescription: notes.md\n---\n${"pad\n".repeat(20_000)}`,
          "utf8",
        ),
        Buffer.from([0xc3, 0x28]),
      ]),
    );
    const provider = resourceProvider();
    const resources = await provider.listResources();
    const target = resources.find((r) => r.name === "notes.md")!;
    expect(await provider.readResource(target.uri)).toBeNull();
    expect(reasons()).toContain("invalid_utf8");
  });
});

/**
 * GUARD: `readScopedFrontmatterDescription`, i.e. the listing's description
 * coming from a read bound to the retained root handle instead of from
 * `scanMemoryFiles`.
 *
 * `scanMemoryFiles` binds the memory directory itself, so it is a second,
 * independent resolution of that name. Flipping the directory's PARENT for
 * exactly the length of the scan lands the scan on an out-of-scope tree while
 * the provider's own bind and admission both land in scope. Deleting the
 * scope-bound read and taking `header.description` back makes this test
 * report the out-of-scope frontmatter under an in-scope URI. Measured without
 * seams against the module before this change: 14 forged listings in 253,480.
 *
 * Flipping a deeper ancestor, inside the scanned tree, does not reproduce it:
 * that trips the scanner's own directory-identity checks. It is the ROOT
 * BINDING that has to be churned.
 */
describe("memory listing metadata", () => {
  test("does not describe an in-scope resource with an out-of-scope file's frontmatter", async () => {
    const sub = join(root, "sub");
    mkdirSync(join(sub, "memory"), { recursive: true });
    writeFileSync(
      join(sub, "memory", "note.md"),
      ["---", "name: note", "description: in-scope note", "---", "in-scope body"].join("\n"),
    );
    const outside = makeOutsideDir();
    mkdirSync(join(outside, "memory"), { recursive: true });
    writeFileSync(
      join(outside, "memory", "note.md"),
      ["---", "name: note", `description: ${FORGED}`, "---", SECRET].join("\n"),
    );
    const provider = resourceProvider({
      memoryDirs: [join(sub, "memory")],
      beforeMemoryScanForTesting: () => {
        renameSync(sub, `${sub}.real`);
        symlinkSync(outside, sub);
      },
      afterMemoryScanForTesting: () => {
        unlinkSync(sub);
        renameSync(`${sub}.real`, sub);
      },
    });
    const resources = await provider.listResources();
    const note = resources.find((r) => r.name === "note.md");
    expect(note).toBeDefined();
    expect(note!.uri).toBe("agenc-memory://0/note.md");
    expect(note!.description).toBe("in-scope note");
    expect(JSON.stringify(resources)).not.toContain(FORGED);
  });
});

/**
 * GUARD: the directory re-proof being `dev`/`ino`/`mode` rather than the full
 * six-field identity.
 *
 * A directory's mtime and ctime advance whenever any child is added, removed,
 * or renamed. While the re-proof compared them, one neighbouring write during
 * a listing emptied the whole listing: measured under purely benign sibling
 * churn with no attacker, the skill listing was available 112 times in
 * 172,076 attempts. Widening the comparison back fails this test.
 */
describe("availability under benign concurrent writes", () => {
  test("still lists a skill while a sibling file is written into the skill root", async () => {
    makeSkill("stable", "safe body");
    const provider = skillProvider({
      beforeReadForTesting: () => {
        writeFileSync(
          join(root, "skills", "sibling.md"),
          ["---", "description: sibling", "---", "neighbour"].join("\n"),
        );
      },
    });
    const prompts = await provider.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("stable");
  });

  test("still lists a memory resource while a sibling file is written into the memory dir", async () => {
    makeMemoryFile("notes.md", "plain body");
    const provider = resourceProvider({
      beforeHeaderReadForTesting: () => {
        writeFileSync(join(root, "memory", "sibling.md"), "neighbour");
      },
    });
    const resources = await provider.listResources();
    expect(resources.map((r) => r.name)).toContain("notes.md");
  });
});

describe("verified memory resource reads", () => {
  test("reads an in-scope memory file with secrets redacted", async () => {
    makeMemoryFile("notes.md", `plain body ${SECRET_TOKEN}`);
    const provider = resourceProvider();
    const resources = await provider.listResources();
    expect(resources.map((r) => r.name)).toContain("notes.md");
    const uri = resources.find((r) => r.name === "notes.md")!.uri;
    const read = await provider.readResource(uri);
    expect(read?.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect(read?.contents[0].text).toContain("plain body");
    expect(read?.contents[0].text).not.toContain(SECRET_TOKEN);
  });

  test("reads only a bounded frontmatter prefix while listing, never a body", async () => {
    makeMemoryFile("notes.md", "plain body");
    let bodyReads = 0;
    let headerReads = 0;
    const provider = resourceProvider({
      beforeReadForTesting: () => {
        bodyReads += 1;
      },
      beforeHeaderReadForTesting: () => {
        headerReads += 1;
      },
    });
    const resources = await provider.listResources();
    // The listing derives its description from the candidate it admitted, so
    // it does take bytes — a bounded frontmatter prefix, not the body.
    expect(headerReads).toBe(1);
    expect(bodyReads).toBe(0);
    const uri = resources.find((r) => r.name === "notes.md")!.uri;
    await provider.readResource(uri);
    expect(bodyReads).toBe(1);
  });

  test("does not list multiply linked memory files", async () => {
    const file = makeMemoryFile("leak.md", SECRET);
    const outsideDir = makeOutsideDir();
    // The memory file now also answers to a name outside the scope root.
    linkSync(file, join(outsideDir, "alias.md"));
    const provider = resourceProvider();
    const resources = await provider.listResources();
    expect(resources.map((r) => r.name)).not.toContain("leak.md");
  });

  test("does not list oversized memory files", async () => {
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(
      join(root, "memory", "huge.md"),
      Buffer.alloc(MAX_SCOPED_FILE_BYTES + 1, 0x61),
    );
    const provider = resourceProvider();
    const resources = await provider.listResources();
    expect(resources.map((r) => r.name)).not.toContain("huge.md");
  });

  test("fails a resource read when the file is swapped for a symlink after validation", async () => {
    makeMemoryFile("notes.md", "plain body");
    const provider = resourceProvider();
    const resources = await provider.listResources();
    const target = resources.find((r) => r.name === "notes.md")!;
    const file = join(root, "memory", "notes.md");
    const secret = makeOutsideSecret("secret.md");
    const swapped = resourceProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        rmSync(file);
        symlinkSync(secret, file);
      },
    });
    expect(await swapped.readResource(target.uri)).toBeNull();
  });

  test("fails a resource read when the open file is replaced before the read", async () => {
    makeMemoryFile("notes.md", "plain body");
    const provider = resourceProvider();
    const resources = await provider.listResources();
    const target = resources.find((r) => r.name === "notes.md")!;
    const file = join(root, "memory", "notes.md");
    const attacker = join(root, "attacker.md");
    writeFileSync(attacker, "attacker body", "utf8");
    const swapped = resourceProvider({
      beforeReadForTesting: (path) => {
        if (path !== file) return;
        renameSync(attacker, file);
      },
    });
    expect(await swapped.readResource(target.uri)).toBeNull();
  });

  test.runIf(process.platform !== "win32")(
    "fails a resource read when the file is replaced by a FIFO after validation without blocking",
    async () => {
      makeMemoryFile("notes.md", "plain body");
      const provider = resourceProvider();
      const resources = await provider.listResources();
      const target = resources.find((r) => r.name === "notes.md")!;
      const file = join(root, "memory", "notes.md");
      const fifo = join(root, "memory", "swap-in.fifo");
      makeFifo(fifo);
      const swapped = resourceProvider({
        beforeOpenForTesting: (path) => {
          if (path !== file) return;
          rmSync(file);
          renameSync(fifo, file);
        },
      });
      expect(await swapped.readResource(target.uri)).toBeNull();
    },
  );
});
