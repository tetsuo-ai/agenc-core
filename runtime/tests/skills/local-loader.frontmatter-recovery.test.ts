import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseBooleanFrontmatter } from "../../src/utils/frontmatterParser.js";
import {
  buildSkillListingWithinBudget,
  loadLocalSkillsSnapshot,
} from "./local-loader.js";

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agenc-${label}-`));
}

function writeSkill(root: string, name: string, body: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, body);
  return file;
}

async function snapshotOf(skills: Record<string, string>) {
  const agencHome = tmpRoot("fm-home");
  const workspaceRoot = tmpRoot("fm-workspace");
  const root = join(agencHome, "skills");
  const files: Record<string, string> = {};
  for (const [name, body] of Object.entries(skills)) {
    files[name] = writeSkill(root, name, body);
  }
  const snapshot = await loadLocalSkillsSnapshot({
    agencHome,
    pluginStorageRoot: join(agencHome, "plugins"),
    workspaceRoot,
    env: {},
  });
  return { snapshot, files };
}

describe("frontmatter the canonical parser accepts", () => {
  // Two installed kit skills on the audited machine have exactly this shape:
  // an unquoted description holding "mode: ..." plus the safety flag. Strict
  // YAML rejects the description line, and the loader used to drop every
  // field with it, so a skill its author marked model-proof was listed to
  // the model and loadable through the Skill tool.
  const body = [
    "---",
    "name: settle-autonomous",
    "description: Settle reviewed tasks in AUTONOMOUS mode: prompt-free, with the hot wallet",
    "disable-model-invocation: true",
    'argument-hint: "[task id]"',
    "---",
    "# Settle",
    "Body",
    "",
  ].join("\n");

  it("keeps disable-model-invocation when a value needs quoting", async () => {
    const { snapshot } = await snapshotOf({ "settle-autonomous": body });
    const skill = snapshot.skills.find((entry) => entry.name === "settle-autonomous");
    expect(skill?.disableModelInvocation).toBe(true);
    expect(skill?.description).toBe(
      "Settle reviewed tasks in AUTONOMOUS mode: prompt-free, with the hot wallet",
    );
    expect(skill?.hasUserSpecifiedDescription).toBe(true);
    expect(skill?.argumentHint).toBe("[task id]");
    // Recovered frontmatter is not a problem to report: every field loaded.
    expect(snapshot.warnings).toEqual([]);
  });

  it("never lists a recovered model-proof skill to the model", async () => {
    const { snapshot } = await snapshotOf({
      "settle-autonomous": body,
      "plain-skill": "---\ndescription: An ordinary skill\n---\nBody\n",
    });
    const { listedNames } = buildSkillListingWithinBudget(snapshot.skills);
    expect(listedNames).toContain("plain-skill");
    expect(listedNames).not.toContain("settle-autonomous");
  });

  it.each([
    "true # safety",
    "TRUE # safety",
    '"true" # safety',
    "'TrUe' # safety",
    "  true  # safety",
  ])("keeps a model-hidden skill hidden with %s", async (flag) => {
    const { snapshot } = await snapshotOf({
      hidden: `---\ndescription: mode: prompt-free\ndisable-model-invocation: ${flag}\n---\n# Hidden\n`,
    });
    expect(snapshot.skills.find((skill) => skill.name === "hidden")?.disableModelInvocation).toBe(true);
    expect(buildSkillListingWithinBudget(snapshot.skills).listedNames).not.toContain("hidden");
  });

  it("accepts a trailing YAML comment in the normal boolean parser", () => {
    expect(parseBooleanFrontmatter(" TRUE # safety ")).toBe(true);
    expect(parseBooleanFrontmatter("false # safety")).toBe(false);
  });

  it("honors a top-level flag with indentation before the key", async () => {
    const { snapshot } = await snapshotOf({
      hidden: "---\n  description: mode: prompt-free\n  disable-model-invocation: TRUE # safety\n---\n# Hidden\n",
    });
    expect(snapshot.skills.find((skill) => skill.name === "hidden")?.disableModelInvocation).toBe(true);
  });

  it("honors the flag even when the rest of the frontmatter cannot be parsed", async () => {
    const { snapshot, files } = await snapshotOf({
      "still-broken": [
        "---",
        "description: fine",
        "  bad: indentation: here",
        "disable-model-invocation: true",
        "---",
        "# Still broken",
        "",
      ].join("\n"),
    });
    const skill = snapshot.skills.find((entry) => entry.name === "still-broken");
    expect(skill?.disableModelInvocation).toBe(true);
    expect(skill?.hasUserSpecifiedDescription).toBe(false);
    expect(snapshot.warnings).toEqual([
      {
        path: files["still-broken"],
        reason: expect.stringMatching(
          /^frontmatter is not valid YAML \(.+\); its fields were ignored, except disable-model-invocation: true, which still keeps the model from loading it$/u,
        ),
      },
    ]);
  });

  it.each([
    "  disable-model-invocation: true",
    "    DISABLE-MODEL-INVOCATION: 'TrUe' # safety",
    '  disable-model-invocation: "TRUE" # safety',
  ])("keeps an indented raw flag hidden despite an unindented invalid line: %s", async (flag) => {
    const { snapshot } = await snapshotOf({
      hidden: ["---", "invalid unindented line", "  description: Hidden skill", flag, "---", "Body", ""].join("\n"),
    });
    expect(snapshot.skills.find((skill) => skill.name === "hidden")?.disableModelInvocation).toBe(true);
    expect(buildSkillListingWithinBudget(snapshot.skills).listedNames).not.toContain("hidden");
  });

  it("does not invent the flag from a value that only mentions it", async () => {
    const { snapshot } = await snapshotOf({
      mention: [
        "---",
        'description: "unclosed',
        "notes: disable-model-invocation: true is how you hide a skill",
        "---",
        "Body",
        "",
      ].join("\n"),
    });
    const skill = snapshot.skills.find((entry) => entry.name === "mention");
    expect(skill?.disableModelInvocation).toBe(false);
  });

  it.each([
    { indicator: "|", flag: "disable-model-invocation: false" },
    { indicator: ">", flag: "" },
  ])("does not hide a skill when a $indicator description contains the flag as text", async ({ indicator, flag }) => {
    const { snapshot } = await snapshotOf({
      example: [
        "---",
        `description: ${indicator}`,
        "  Example frontmatter:",
        "  disable-model-invocation: true",
        flag,
        "---",
        "# Example",
        "",
      ].filter(Boolean).join("\n"),
    });
    const skill = snapshot.skills.find((entry) => entry.name === "example");
    expect(skill?.disableModelInvocation).toBe(false);
    expect(buildSkillListingWithinBudget(snapshot.skills).listedNames).toContain("example");
  });

  it("trusts valid YAML over the line scan for a flow key at column zero", async () => {
    // Flow collections ignore indentation, so this key belongs to metadata.
    const { snapshot } = await snapshotOf({
      example: [
        "---",
        "description: A visible skill",
        "metadata: {",
        "disable-model-invocation: true",
        "}",
        "disable-model-invocation: false",
        "---",
        "# Example",
        "",
      ].join("\n"),
    });
    expect(snapshot.skills.find((entry) => entry.name === "example")?.disableModelInvocation).toBe(false);
    expect(buildSkillListingWithinBudget(snapshot.skills).listedNames).toContain("example");
  });

  it("does not use block scalar text as a fallback flag when another field is invalid", async () => {
    const { snapshot } = await snapshotOf({
      example: [
        "---",
        "description: |",
        "  disable-model-invocation: true",
        "invalid unindented line",
        "---",
        "# Example",
        "",
      ].join("\n"),
    });
    expect(snapshot.skills.find((entry) => entry.name === "example")?.disableModelInvocation).toBe(false);
    expect(buildSkillListingWithinBudget(snapshot.skills).listedNames).toContain("example");
  });

  it.each([
    { name: "flow mapping", value: "{", close: "}" },
    { name: "flow mapping with an inline entry", value: "{ other: 1,", close: "}", inlineOther: true },
    { name: "flow sequence", value: "[", close: "]" },
    { name: "anchored mapping", value: "&example", close: "" },
    { name: "anchored flow mapping", value: "&example {", close: "}" },
    { name: "anchored flow mapping with no space", value: "&example{", close: "}" },
  ])("does not treat a flag inside a $name as top-level", async ({ value, close, inlineOther }) => {
    const { snapshot } = await snapshotOf({
      example: [
        "---",
        "description: A visible skill",
        `metadata: ${value}`,
        inlineOther ? "" : `  other: 1${close ? "," : ""}`,
        "  disable-model-invocation: true",
        close,
        "disable-model-invocation: false",
        "---",
        "# Example",
        "",
      ].filter(Boolean).join("\n"),
    });
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.skills.find((skill) => skill.name === "example")?.disableModelInvocation).toBe(false);
    expect(buildSkillListingWithinBudget(snapshot.skills).listedNames).toContain("example");
  });
});
