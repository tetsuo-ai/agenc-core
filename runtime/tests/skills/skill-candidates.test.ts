import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadLocalSkillsSnapshot } from "../../src/skills/local-loader.js";
import {
  acceptSkillCandidate,
  isSkillCandidatesDisabledByEnv,
  listSkillCandidates,
  MAX_SKILL_CANDIDATE_BODY_BYTES,
  MAX_SKILL_CANDIDATES_PER_RUN,
  parseSkillCandidateProposals,
  readSkillCandidateFile,
  readSkillCandidateLedger,
  rejectSkillCandidate,
  renderSkillCandidateFile,
  resolveSkillCandidatesRoot,
  SkillCandidateError,
  validateSkillCandidateProposal,
  writeSkillCandidates,
} from "../../src/skills/skill-candidates.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));

const BODY = [
  "# Purpose",
  "",
  "Run one runtime test file in isolation.",
  "",
  "## Steps",
  "",
  "1. cd runtime",
  "2. node scripts/run-hermetic-vitest.mjs run <file>",
  "",
  "## Verification",
  "",
  "The summary line reports every file as passed.",
  "",
  "## Pitfalls",
  "",
  "Never point AGENC_HOME at the real home while testing.",
].join("\n");

function proposal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "run-hermetic-vitest",
    description: "Run one runtime test file through the hermetic vitest runner.",
    whenToUse: "When a runtime change needs its tests run in isolation.",
    body: BODY,
    evidence: [
      "Three hermetic runs in the session, each checked against the summary line.",
    ],
    ...overrides,
  };
}

function reply(payload: unknown): string {
  return `Memory updated.\n\n\`\`\`skill-candidates\n${JSON.stringify(payload)}\n\`\`\`\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-cand-home-"));
}

describe("skill candidate proposals", () => {
  it("parses a valid block into a trimmed candidate", () => {
    const parsed = parseSkillCandidateProposals(
      reply({
        skillCandidates: [
          proposal({ description: "  Run the hermetic runner.  " }),
        ],
      }),
    );
    expect(parsed.dropped).toEqual([]);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toMatchObject({
      name: "run-hermetic-vitest",
      description: "Run the hermetic runner.",
      whenToUse: "When a runtime change needs its tests run in isolation.",
    });
    expect(parsed.candidates[0]?.evidence).toHaveLength(1);
  });

  it("accepts a bare array and finds the block after other prose", () => {
    const parsed = parseSkillCandidateProposals(
      `Saved two memories.\n\n\`\`\`skill-candidates\n${JSON.stringify([proposal()])}\n\`\`\`\nDone.`,
    );
    expect(parsed.candidates.map((candidate) => candidate.name)).toEqual([
      "run-hermetic-vitest",
    ]);
  });

  it("keeps the first two entries and drops the rest with a reason", () => {
    const parsed = parseSkillCandidateProposals(
      reply({
        skillCandidates: [
          proposal({ name: "first-one" }),
          proposal({ name: "second-one" }),
          proposal({ name: "third-one" }),
        ],
      }),
    );
    expect(parsed.candidates.map((candidate) => candidate.name)).toEqual([
      "first-one",
      "second-one",
    ]);
    expect(parsed.candidates).toHaveLength(MAX_SKILL_CANDIDATES_PER_RUN);
    expect(parsed.dropped).toEqual([
      `third-one: over the per-run cap of ${MAX_SKILL_CANDIDATES_PER_RUN}`,
    ]);
  });

  it("drops a name that is not a kebab-case slug", () => {
    for (const name of ["Run Tests", "run_tests", "-leading", "trailing-", "ab", "../escape", "a".repeat(65)]) {
      const validation = validateSkillCandidateProposal(proposal({ name }));
      expect(validation.ok, name).toBe(false);
      if (!validation.ok) expect(validation.reason).toContain("kebab-case");
    }
    const parsed = parseSkillCandidateProposals(
      reply({ skillCandidates: [proposal({ name: "Bad Name" })] }),
    );
    expect(parsed.candidates).toEqual([]);
    expect(parsed.dropped).toHaveLength(1);
  });

  it("drops a body over the 16 KiB cap and an empty or multi-line description", () => {
    const tooLong = validateSkillCandidateProposal(
      proposal({ body: "x".repeat(MAX_SKILL_CANDIDATE_BODY_BYTES + 1) }),
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.reason).toContain("the cap is 16384");
    expect(
      validateSkillCandidateProposal(
        proposal({ body: "x".repeat(MAX_SKILL_CANDIDATE_BODY_BYTES) }),
      ).ok,
    ).toBe(true);
    expect(validateSkillCandidateProposal(proposal({ description: "" })).ok).toBe(false);
    expect(
      validateSkillCandidateProposal(proposal({ whenToUse: "two\nlines" })).ok,
    ).toBe(false);
    expect(validateSkillCandidateProposal(proposal({ evidence: [] })).ok).toBe(false);
  });

  it("drops a candidate whose text trips the secrets scan", () => {
    const secret = `sk_live_${"a1b2c3d4".repeat(4)}`;
    const validation = validateSkillCandidateProposal(
      proposal({ body: `${BODY}\n\nUse the key ${secret} to log in.\n` }),
    );
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.reason).toContain("potential secrets");
    const inEvidence = validateSkillCandidateProposal(
      proposal({ evidence: [`Logged in with ${secret} `] }),
    );
    expect(inEvidence.ok).toBe(false);
  });

  it("ignores replies without a block and reports a malformed one", () => {
    expect(parseSkillCandidateProposals(undefined)).toEqual({
      candidates: [],
      dropped: [],
    });
    expect(parseSkillCandidateProposals("Memory updated, nothing to propose.")).toEqual({
      candidates: [],
      dropped: [],
    });
    const malformed = parseSkillCandidateProposals(
      "```skill-candidates\n{not json\n```",
    );
    expect(malformed.candidates).toEqual([]);
    expect(malformed.dropped[0]).toContain("not valid JSON");
    const wrongShape = parseSkillCandidateProposals(
      "```skill-candidates\n{\"other\": 1}\n```",
    );
    expect(wrongShape.dropped[0]).toContain("skillCandidates array");
  });

  it("renders loader frontmatter once, even when the body brought its own", () => {
    const validation = validateSkillCandidateProposal(
      proposal({
        body: `---\nname: whatever\ndescription: stale\n---\n${BODY}`,
        description: 'Run tests: the "hermetic" way',
      }),
    );
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const rendered = renderSkillCandidateFile(validation.candidate);
    expect(rendered.startsWith("---\nname: \"run-hermetic-vitest\"\n")).toBe(true);
    expect(rendered).toContain('description: "Run tests: the \\"hermetic\\" way"');
    expect(rendered).toContain(
      'when_to_use: "When a runtime change needs its tests run in isolation."',
    );
    expect(rendered.match(/^---$/gmu)).toHaveLength(2);
    expect(rendered).not.toContain("description: stale");
    expect(rendered).toContain("## Verification");
  });

  it("is switched off by AGENC_SKILL_CANDIDATES=0 and equivalent spellings", () => {
    for (const value of ["0", "false", "off", "no"]) {
      expect(isSkillCandidatesDisabledByEnv({ AGENC_SKILL_CANDIDATES: value })).toBe(true);
    }
    for (const value of [undefined, "", "1", "true"]) {
      expect(isSkillCandidatesDisabledByEnv({ AGENC_SKILL_CANDIDATES: value })).toBe(false);
    }
  });
});

describe("skill candidate drafts on disk", () => {
  it("writes drafts under skill-candidates with provenance and a ledger line, never under the skills root", async () => {
    const home = await tempHome();
    const parsed = parseSkillCandidateProposals(
      reply({ skillCandidates: [proposal()] }),
    );
    const result = await writeSkillCandidates({
      agencHome: home,
      candidates: parsed.candidates,
      installedSkillNames: ["verify", "batch"],
      provenance: {
        sessionId: "conv-1",
        conversationId: "conv-1",
        model: "test-model",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    });

    const directory = join(home, "skill-candidates", "run-hermetic-vitest");
    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual([{ slug: "run-hermetic-vitest", path: directory }]);
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toContain(
      'name: "run-hermetic-vitest"',
    );
    expect(JSON.parse(await readFile(join(directory, "candidate.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      slug: "run-hermetic-vitest",
      name: "run-hermetic-vitest",
      description: "Run one runtime test file through the hermetic vitest runner.",
      whenToUse: "When a runtime change needs its tests run in isolation.",
      evidence: [
        "Three hermetic runs in the session, each checked against the summary line.",
      ],
      provenance: {
        sessionId: "conv-1",
        conversationId: "conv-1",
        createdAt: "2026-09-05T00:00:00.000Z",
        model: "test-model",
      },
    });
    expect(await readSkillCandidateLedger(home)).toEqual([
      {
        slug: "run-hermetic-vitest",
        action: "proposed",
        at: "2026-09-05T00:00:00.000Z",
        sessionId: "conv-1",
      },
    ]);
    expect(await exists(join(home, "skills"))).toBe(false);
    expect(resolveSkillCandidatesRoot(home)).toBe(join(home, "skill-candidates"));
  });

  it("skips names that are installed skills or existing drafts and leaves the ledger alone", async () => {
    const home = await tempHome();
    const first = await writeSkillCandidates({
      agencHome: home,
      candidates: parseSkillCandidateProposals(
        reply({ skillCandidates: [proposal(), proposal({ name: "verify" })] }),
      ).candidates,
      installedSkillNames: ["verify"],
      provenance: { sessionId: "conv-1" },
    });
    expect(first.written.map((entry) => entry.slug)).toEqual(["run-hermetic-vitest"]);
    expect(first.skipped).toEqual([
      { slug: "verify", reason: "a skill with this name is already installed" },
    ]);

    const before = await readFile(join(home, "skill-candidates", "run-hermetic-vitest", "SKILL.md"), "utf8");
    const again = await writeSkillCandidates({
      agencHome: home,
      candidates: parseSkillCandidateProposals(
        reply({ skillCandidates: [proposal({ description: "A different draft." })] }),
      ).candidates,
      installedSkillNames: [],
      provenance: { sessionId: "conv-2" },
    });
    expect(again.written).toEqual([]);
    expect(again.skipped).toEqual([
      { slug: "run-hermetic-vitest", reason: "a candidate with this name already exists" },
    ]);
    expect(await readFile(join(home, "skill-candidates", "run-hermetic-vitest", "SKILL.md"), "utf8")).toBe(before);
    expect(await readSkillCandidateLedger(home)).toHaveLength(1);
  });

  it("is invisible to the skills loader until accepted", async () => {
    const home = await tempHome();
    const fakeUserHome = await tempHome();
    const workspaceRoot = await tempHome();
    await mkdir(join(home, "skills", "real-skill"), { recursive: true });
    await writeFile(
      join(home, "skills", "real-skill", "SKILL.md"),
      "---\nname: real-skill\ndescription: an installed skill\n---\n# real-skill\n",
    );
    await writeSkillCandidates({
      agencHome: home,
      candidates: parseSkillCandidateProposals(
        reply({ skillCandidates: [proposal()] }),
      ).candidates,
      installedSkillNames: ["real-skill"],
      provenance: {},
    });
    const options = {
      agencHome: home,
      pluginStorageRoot: join(home, "plugins"),
      workspaceRoot,
      env: { HOME: fakeUserHome },
    };

    const before = await loadLocalSkillsSnapshot(options);
    expect(before.skills.map((skill) => skill.name)).toContain("real-skill");
    expect(before.skills.map((skill) => skill.name)).not.toContain("run-hermetic-vitest");
    // No discovered root is the candidates directory or anything below it.
    expect(
      before.skillRoots.filter((root) => root.split(sep).includes("skill-candidates")),
    ).toEqual([]);

    await acceptSkillCandidate({
      agencHome: home,
      slug: "run-hermetic-vitest",
      installedSkillNames: before.skills.map((skill) => skill.name),
    });
    const after = await loadLocalSkillsSnapshot(options);
    const accepted = after.skills.find((skill) => skill.name === "run-hermetic-vitest");
    expect(accepted).toBeDefined();
    expect(accepted?.scope).toBe("user");
    expect(accepted?.whenToUse).toBe(
      "When a runtime change needs its tests run in isolation.",
    );
    expect(await exists(join(home, "skills", "run-hermetic-vitest", "candidate.json"))).toBe(false);
    expect(await exists(join(home, "skill-candidates", "run-hermetic-vitest"))).toBe(false);
  });

  it("lists, shows, accepts and rejects drafts and refuses to accept a taken name", async () => {
    const home = await tempHome();
    await writeSkillCandidates({
      agencHome: home,
      candidates: parseSkillCandidateProposals(
        reply({
          skillCandidates: [proposal(), proposal({ name: "taken-name", evidence: ["a", "b"] })],
        }),
      ).candidates,
      installedSkillNames: [],
      provenance: { createdAt: "2026-09-05T01:02:03.000Z" },
    });

    const listing = await listSkillCandidates(home);
    expect(listing.errors).toEqual([]);
    expect(listing.candidates.map((candidate) => [candidate.slug, candidate.evidenceCount, candidate.createdAt])).toEqual([
      ["run-hermetic-vitest", 1, "2026-09-05T01:02:03.000Z"],
      ["taken-name", 2, "2026-09-05T01:02:03.000Z"],
    ]);
    expect(await readSkillCandidateFile(home, "taken-name")).toContain('name: "taken-name"');
    await expect(readSkillCandidateFile(home, "missing-one")).rejects.toMatchObject({
      code: "not_found",
    });

    await expect(
      acceptSkillCandidate({ agencHome: home, slug: "taken-name", installedSkillNames: ["taken-name"] }),
    ).rejects.toMatchObject({ code: "name_taken" });
    await mkdir(join(home, "skills", "taken-name"), { recursive: true });
    await expect(
      acceptSkillCandidate({ agencHome: home, slug: "taken-name", installedSkillNames: [] }),
    ).rejects.toMatchObject({ code: "name_taken" });
    expect(await exists(join(home, "skill-candidates", "taken-name", "SKILL.md"))).toBe(true);

    await rejectSkillCandidate(home, "taken-name", "conv-9");
    expect(await exists(join(home, "skill-candidates", "taken-name"))).toBe(false);
    await expect(rejectSkillCandidate(home, "taken-name")).rejects.toBeInstanceOf(SkillCandidateError);
    await expect(
      acceptSkillCandidate({ agencHome: home, slug: "not-a-draft", installedSkillNames: [] }),
    ).rejects.toMatchObject({ code: "not_found" });

    const accepted = await acceptSkillCandidate({
      agencHome: home,
      slug: "run-hermetic-vitest",
      installedSkillNames: ["verify"],
    });
    expect(accepted.path).toBe(join(home, "skills", "run-hermetic-vitest"));
    expect(await exists(join(accepted.path, "SKILL.md"))).toBe(true);
    expect((await listSkillCandidates(home)).candidates).toEqual([]);
    expect((await readSkillCandidateLedger(home)).map((entry) => `${entry.slug}:${entry.action}`)).toEqual([
      "run-hermetic-vitest:proposed",
      "taken-name:proposed",
      "taken-name:rejected",
      "run-hermetic-vitest:accepted",
    ]);
    expect((await readSkillCandidateLedger(home))[2]).toMatchObject({ sessionId: "conv-9" });
  });

  it("refuses a slug that could leave the candidates directory", async () => {
    const home = await tempHome();
    await expect(readSkillCandidateFile(home, "../skills")).rejects.toMatchObject({
      code: "invalid_slug",
    });
    await expect(rejectSkillCandidate(home, "Skills")).rejects.toMatchObject({
      code: "invalid_slug",
    });
  });
});
