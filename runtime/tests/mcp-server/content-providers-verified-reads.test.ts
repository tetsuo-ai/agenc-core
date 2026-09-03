/**
 * Regression tests for issue #1794: MCP content providers must serve skill
 * prompts, resource bodies, AND listing metadata from a location proven
 * against a retained root descriptor, never from a pathname resolved a second
 * time.
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
 *   - `nlink === 1n` is two source clauses reached from three call sites
 *     (listing admission and the opened handle in `readScopedRegularFile`
 *     share one clause; `openVerifiedCandidate` has the other). Deleting
 *     either clause leaves the suite green; only deleting both fails it.
 *   - the root symlink pre-check in `bindVerifiedRoot` is not pinned by
 *     anything behavioural, and it is not `O_DIRECTORY`/`O_NOFOLLOW` that
 *     stands in for it: deleting `before.isSymbolicLink()` AND both directory
 *     open flags leaves every behavioural test in this file, in
 *     `tests/fs/verified-read.test.ts`, and in `tests/memory/scan.test.ts`
 *     green — only the flag-VALUE test fails, and that one asserts a number,
 *     not an open. Its real partner is `!before.isDirectory()` in the same
 *     expression: `lstat` of a symlink reports `isDirectory()` false, so that
 *     clause rejects a symlinked root on its own. Delete the whole expression
 *     and "refuses a root that is a symlink" finally fails.
 *   - the `isContained` pre-check in `openVerifiedCandidate` is redundant with
 *     the ancestor walk's canonical containment for every reachable escape.
 *   - `fatal: true` in `decodeScopedPrefix` — see the note in "scope-bound
 *     description reads".
 *
 * Two guards live in another module and are recorded here so this file is not
 * read as covering them: "does not list multiply linked memory files" passes
 * because `scanMemoryFiles` refuses a multiply linked candidate before a name
 * reaches these providers at all, not because of anything here; and the
 * memory listing's availability under concurrent writes is decided by the
 * directory proofs in `runtime/src/memory/scan.ts`, whose own mutation tests
 * live in `tests/memory/scan.test.ts`.
 *
 * Tests that used to pass for the wrong reason and now do not: the pre-open
 * ancestor walk (see "at the open boundary") stayed green when it was
 * deleted, because the test's own restore step moved the bound root's
 * timestamps and the POST-read walk rejected instead; the same-inode symlink
 * test named a proof that never runs; and the memory availability test fired
 * its write after `scanMemoryRoots` had already returned, so it passed with
 * the scan's directory proofs left at their broken width — verified by
 * widening them back, at which point the write at
 * `beforeHeaderReadForTesting` and the identical write at
 * `beforeMemoryScanForTesting` both still passed and only the write at
 * `duringMemoryScanForTesting` failed.
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
 * report the out-of-scope frontmatter under an in-scope URI.
 *
 * It is not a narrow window. Free-running against the pre-fix module, with
 * the attacker in a separate process and no seams, an ASYMMETRIC duty cycle
 * (ON ~700us, long enough to span the whole scan; OFF ~250us, spanning the
 * provider's own bind and admission) forged 330 of 330 served listings across
 * 45,019 attempts. Symmetric cycles find nothing, which is what an earlier
 * "0 across 1.9M attempts, window too narrow" note was actually measuring.
 * The same harness against this module: 0 forged of 399 served in 88,077
 * attempts at that tuning, and 0 of 14,441 served in 43,261 attempts at ON
 * 700us / OFF 2500us, where the listing succeeds most of the time.
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
 * The description a memory listing serves is now read through the retained
 * root handle, and the guards on that read are pinned here one at a time.
 *
 * The read is small — open the admitted candidate, prove it is the admitted
 * one, take a bounded frontmatter prefix, re-prove the object and the
 * ancestor chain — but every one of those clauses could be deleted with the
 * whole suite green until these tests existed. The first one matters most:
 * it fails if `readScopedFrontmatterDescription` is replaced by a plain
 * `readFile` of the candidate's pathname, which is the original #1794 leak
 * written back in.
 */
describe("scope-bound description reads", () => {
  /** Memory dir at `<root>/sub/memory`, with a forged twin outside the scope. */
  function flippableMemoryDir(): { sub: string; outside: string } {
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
    return { sub, outside };
  }

  /**
   * GUARD: the description read going through the bound root handle at all.
   *
   * The candidate's parent is repointed at an out-of-scope tree AFTER the
   * verified open and held there across the read. Reading through the handle
   * yields in-scope bytes and the post-read proofs then reject, so the
   * listing carries no description. A `readFile(join(requestedPath, rel))` in
   * the same place resolves the name a second time, through the flipped
   * parent, and serves the out-of-scope frontmatter under the in-scope URI —
   * which is exactly what `resources/list` did before this round.
   */
  test("does not describe a resource through a parent flipped across the read", async () => {
    const { sub, outside } = flippableMemoryDir();
    let flipped = false;
    const provider = resourceProvider({
      memoryDirs: [join(sub, "memory")],
      beforeHeaderReadForTesting: () => {
        if (flipped) return;
        flipped = true;
        renameSync(sub, `${sub}.real`);
        symlinkSync(outside, sub);
      },
    });
    const resources = await provider.listResources();
    expect(flipped).toBe(true);
    const note = resources.find((r) => r.name === "note.md");
    expect(note).toBeDefined();
    expect(note!.uri).toBe("agenc-memory://0/note.md");
    expect(note!.description).toBeUndefined();
    expect(JSON.stringify(resources)).not.toContain(FORGED);
    // Cleanup runs on a real directory, not the symlink.
    unlinkSync(sub);
    renameSync(`${sub}.real`, sub);
  });

  /**
   * GUARD: `sameStats(admitted, openedIdentity)` in
   * `readScopedFrontmatterDescription`.
   *
   * The candidate is exchanged for another regular file between admission
   * and the verified open. The replacement opens and verifies perfectly on
   * its own terms — right type, one link, path and handle agree — so
   * `openVerifiedCandidate` returns a handle and nothing downstream objects.
   * Only the comparison against the identity admission recorded notices that
   * the listing is about to describe a file it never admitted.
   */
  test("does not describe a candidate exchanged between admission and the open", async () => {
    makeMemoryFile("notes.md", "plain body");
    const file = join(root, "memory", "notes.md");
    const replacement = join(root, "replacement.md");
    writeFileSync(
      replacement,
      ["---", "name: notes", `description: ${FORGED}`, "---", SECRET].join("\n"),
    );
    let swapped = false;
    const provider = resourceProvider({
      beforeDescriptionOpenForTesting: (path) => {
        if (path !== file || swapped) return;
        swapped = true;
        renameSync(replacement, file);
      },
    });
    const resources = await provider.listResources();
    expect(swapped).toBe(true);
    const note = resources.find((r) => r.name === "notes.md")!;
    expect(note.description).toBeUndefined();
    expect(JSON.stringify(resources)).not.toContain(FORGED);
    expect(reasons()).toContain("verification_failed");
  });

  /**
   * GUARD: the handle side of `assertCandidateUnchanged` on the description
   * path.
   *
   * The file is rewritten in place after the open, so the descriptor still
   * points at the same inode and every path-based check agrees. The bytes
   * this read returns are the new ones; only re-proving the opened object
   * against what it was at open time notices.
   */
  test("does not describe a candidate rewritten in place after the open", async () => {
    makeMemoryFile("notes.md", "plain body");
    const file = join(root, "memory", "notes.md");
    let mutated = false;
    const provider = resourceProvider({
      beforeHeaderReadForTesting: (path) => {
        if (path !== file || mutated) return;
        mutated = true;
        writeFileSync(
          file,
          ["---", "name: notes", `description: ${FORGED}`, "---", SECRET, "x".repeat(400)].join("\n"),
        );
      },
    });
    const resources = await provider.listResources();
    expect(mutated).toBe(true);
    const note = resources.find((r) => r.name === "notes.md")!;
    expect(note.description).toBeUndefined();
    expect(JSON.stringify(resources)).not.toContain(FORGED);
    expect(reasons()).toContain("verification_failed");
  });

  /**
   * GUARD: the path side of `assertCandidateUnchanged` on the description
   * path.
   *
   * Exchanging the directory that holds a nested candidate leaves the open
   * inode untouched, so the handle side passes; and the exchanged directory
   * is a real, contained, non-symlink directory below an unmoved root, so the
   * ancestor walk passes too. Only comparing the pathname's object against
   * the one that was opened sees that the name now leads somewhere else.
   */
  test("does not describe a nested candidate whose directory is exchanged", async () => {
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
      ["---", "name: notes", `description: ${FORGED}`, "---", SECRET].join("\n"),
    );
    const file = join(nested, "notes.md");
    let exchanged = false;
    const provider = resourceProvider({
      beforeHeaderReadForTesting: (path) => {
        if (path !== file || exchanged) return;
        exchanged = true;
        renameSync(nested, join(root, "b.away"));
        renameSync(decoy, nested);
      },
    });
    const resources = await provider.listResources();
    expect(exchanged).toBe(true);
    const note = resources.find((r) => r.name.endsWith("notes.md"))!;
    expect(note.description).toBeUndefined();
    expect(JSON.stringify(resources)).not.toContain(FORGED);
    expect(reasons()).toContain("verification_failed");
  });

  /**
   * GUARD: the post-read `verifyParentChain` on the description path.
   *
   * The ancestor is replaced by a symlink to ITSELF, so the candidate's
   * pathname still resolves to the very same inode and both sides of
   * `assertCandidateUnchanged` agree. Only the ancestor walk, which rejects a
   * symlinked parent segment outright, can reject here — and the reason it
   * reports is what makes this test isolating.
   */
  test("does not describe a candidate whose ancestor becomes a symlink", async () => {
    const dir = join(root, "memory", "nested");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "notes.md"),
      ["---", "name: notes", "description: nested notes", "---", "safe body"].join("\n"),
    );
    const file = join(dir, "notes.md");
    let linked = false;
    const provider = resourceProvider({
      beforeHeaderReadForTesting: (path) => {
        if (path !== file || linked) return;
        linked = true;
        renameSync(dir, `${dir}.real`);
        symlinkSync("nested.real", dir);
      },
    });
    const resources = await provider.listResources();
    expect(linked).toBe(true);
    const note = resources.find((r) => r.name.endsWith("notes.md"))!;
    expect(note.description).toBeUndefined();
    expect(reasons()).toContain("ancestor_changed");
  });

  /*
   * NOT KILLABLE, and the reason is structural rather than a gap.
   *
   * `fatal: true` in `decodeScopedPrefix` has no behavioural mutant reachable
   * from this module. Its only caller is the memory listing, and a memory
   * listing only ever sees names `scanMemoryRoots` produced; the scan decodes
   * the first 65,536 bytes of every candidate with a fatal decoder of its own
   * and drops the file if that fails, which is strictly wider and strictly
   * earlier than this module's 8,192-byte prefix. So no file that reaches
   * `decodeScopedPrefix` can carry invalid bytes in the window it reads, and
   * the lenient mutant serves exactly what the strict one does.
   *
   * The clause stays anyway. This module's whole stance is that the scan is an
   * untrusted source of candidate names and nothing else; leaning on the
   * scan's decode to justify deleting this one would be trusting precisely
   * what the module refuses to trust. The corresponding clause on the BODY
   * path, which has no scan in front of it, is killed by two tests.
   */

  /**
   * GUARD: the truncation-tolerance loop (`minimumEnd`) in
   * `decodeScopedPrefix`.
   *
   * The listing reads a bounded 8 KiB prefix, and a prefix boundary lands
   * wherever the file happens to put it — including inside a multi-byte
   * sequence. This file is built so byte 8191 is the lead byte of a two-byte
   * character, so the prefix ends mid-sequence: a fatal decode of the whole
   * prefix fails, and only backing off up to three bytes recovers the
   * frontmatter. Without the loop, any memory file over 8 KiB that happens to
   * split a character at the boundary silently loses its description.
   */
  test("describes a memory file whose 8 KiB prefix is cut mid-sequence", async () => {
    mkdirSync(join(root, "memory"), { recursive: true });
    const header = Buffer.from(
      ["---", "name: cut", "description: cut prefix", "---", ""].join("\n"),
      "utf8",
    );
    const padding = Buffer.alloc(8_191 - header.byteLength, 0x61);
    const split = Buffer.from("é", "utf8");
    expect(split.byteLength).toBe(2);
    const tail = Buffer.alloc(64, 0x61);
    const bytes = Buffer.concat([header, padding, split, tail]);
    expect(bytes.byteLength).toBeGreaterThan(8_192);
    expect(bytes[8_191]).toBe(0xc3);
    writeFileSync(join(root, "memory", "cut.md"), bytes);
    const provider = resourceProvider();
    const resources = await provider.listResources();
    const note = resources.find((r) => r.name === "cut.md")!;
    expect(note.description).toBe("cut prefix");
  });
});

/**
 * GUARD: the directory re-proof being `dev`/`ino`/`mode` rather than the full
 * six-field identity.
 *
 * A directory's mtime and ctime advance whenever any child is added, removed,
 * or renamed. While the re-proof compared them, one neighbouring write during
 * a listing emptied the whole listing.
 *
 * The two surfaces are separate and measure separately, because they go
 * through different modules:
 *
 *   SKILL listing   `fs/verified-read.ts` proofs. 102 of 116,343 = 0.09%
 *                   before narrowing, 33,622 of 33,622 = 100.00% after.
 *   MEMORY listing  `memory/scan.ts` proofs, which the first narrowing did
 *                   not touch. 113 of 76,583 = 0.15% before, 22,561 of
 *                   22,561 = 100.00% after.
 *
 * All measured with one separate process writing and removing a single
 * sibling file, no attacker. Controls: no churn 100.00%, churn in a directory
 * outside the listed root 100.00%.
 *
 * Widening either module's directory comparison back fails one of these two
 * tests.
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

  /**
   * The memory listing's availability is decided INSIDE `scanMemoryRoots`,
   * not in this module: `listMemoryResources` cannot produce a single
   * resource without the scan, and a failed scan yields no names at all. So
   * the write has to land inside the scan, and `duringMemoryScanForTesting`
   * is the only seam that reaches there.
   *
   * The earlier version of this test wrote at `beforeHeaderReadForTesting`,
   * which fires long after `scanMemoryRoots` has returned; the identical
   * write also passed at `beforeMemoryScanForTesting`, which fires before the
   * scan binds anything. Neither could fail, so neither pinned anything, and
   * the memory listing sat at 0.17% availability under exactly the churn this
   * test claimed to cover.
   */
  test("still lists a memory resource while a sibling file is written during the scan", async () => {
    makeMemoryFile("notes.md", "plain body");
    let wrote = false;
    const provider = resourceProvider({
      duringMemoryScanForTesting: () => {
        if (wrote) return;
        wrote = true;
        writeFileSync(join(root, "memory", "sibling.md"), "neighbour");
      },
    });
    const resources = await provider.listResources();
    expect(wrote).toBe(true);
    expect(resources.map((r) => r.name)).toContain("notes.md");
  });
});

/**
 * The memory listing's one remaining failure mode, written down rather than
 * hidden: a scan that does not complete produces no candidate NAMES, so the
 * listing drops every memory resource under that directory. It has always
 * behaved this way — `scanMemoryFiles` returns an empty array for a failed
 * scan — and this round did not change it; what changed is that the reason
 * reaches `onRejected` instead of vanishing.
 */
describe("memory scan failure", () => {
  test("reports a directory whose scan did not complete instead of dropping it silently", async () => {
    makeMemoryFile("notes.md", "plain body");
    const dir = join(root, "memory");
    const outside = makeOutsideDir();
    let broke = false;
    const provider = resourceProvider({
      duringMemoryScanForTesting: () => {
        if (broke) return;
        broke = true;
        renameSync(dir, `${dir}.real`);
        symlinkSync(outside, dir);
      },
    });
    const resources = await provider.listResources();
    expect(broke).toBe(true);
    expect(resources).toEqual([]);
    expect(reasons()).toContain("root_unavailable");
    unlinkSync(dir);
    renameSync(`${dir}.real`, dir);
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
