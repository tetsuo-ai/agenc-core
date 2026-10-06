import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as mcpArgs from "../../src/bin/mcp-cli-args.js";
import * as doctorArgs from "../../src/bin/doctor-cli-args.js";
import * as trajectoryArgs from "../../src/bin/trajectories-cli-args.js";
import * as skillsArgs from "../../src/skills/skills-cli-args.js";
import * as skillNames from "../../src/skills/skill-candidate-names.js";
import * as trajectoryNames from "../../src/session/trajectory-export-constants.js";

const evaluations = vi.hoisted(() => ({ mcp: 0, doctor: 0, trajectories: 0, skills: 0, slash: 0 }));

// Instrument only executor module evaluation. Every export remains the actual
// implementation; in particular no parser, permission, or shared policy is mocked.
vi.mock("../../src/bin/mcp-cli.js", async (original) => {
  evaluations.mcp++;
  return original();
});
vi.mock("../../src/bin/doctor-cli.js", async (original) => {
  evaluations.doctor++;
  return original();
});
vi.mock("../../src/bin/trajectories-cli.js", async (original) => {
  evaluations.trajectories++;
  return original();
});
vi.mock("../../src/skills/skills-cli.js", async (original) => {
  evaluations.skills++;
  return original();
});
vi.mock("../../src/bin/slash.js", async (original) => {
  evaluations.slash++;
  return original();
});

let coldEvaluations: typeof evaluations;
let cli: typeof import("../../src/bin/agenc-main.js");

beforeAll(async () => {
  const previous = process.env.AGENC_CLI_ENTRY_DISABLE;
  process.env.AGENC_CLI_ENTRY_DISABLE = "1";
  try {
    cli = await import("../../src/bin/agenc-main.js");
    coldEvaluations = { ...evaluations };
  } finally {
    if (previous === undefined) delete process.env.AGENC_CLI_ENTRY_DISABLE;
    else process.env.AGENC_CLI_ENTRY_DISABLE = previous;
  }
}, 30_000);

describe("CLI cold executor boundary", () => {
  it("imports the real CLI without evaluating the extracted executors or slash", () => {
    expect(coldEvaluations).toEqual({ mcp: 0, doctor: 0, trajectories: 0, skills: 0, slash: 0 });
    expect(cli.main).toBeTypeOf("function");
  });

  it("reexports the same parser/help bindings from each actual facade", async () => {
    const mcp = await import("../../src/bin/mcp-cli.js");
    const doctor = await import("../../src/bin/doctor-cli.js");
    const trajectories = await import("../../src/bin/trajectories-cli.js");
    const skills = await import("../../src/skills/skills-cli.js");
    expect(mcp.parseAgenCMcpCliArgs).toBe(mcpArgs.parseAgenCMcpCliArgs);
    expect(mcp.parseMcpServeArgs).toBe(mcpArgs.parseMcpServeArgs);
    expect(mcp.formatAgenCMcpCliHelpText).toBe(mcpArgs.formatAgenCMcpCliHelpText);
    expect(doctor.parseAgenCDoctorCliArgs).toBe(doctorArgs.parseAgenCDoctorCliArgs);
    expect(doctor.formatAgenCDoctorCliHelpText).toBe(doctorArgs.formatAgenCDoctorCliHelpText);
    expect(trajectories.parseAgenCTrajectoriesCliArgs).toBe(trajectoryArgs.parseAgenCTrajectoriesCliArgs);
    expect(trajectories.formatAgenCTrajectoriesCliHelpText).toBe(trajectoryArgs.formatAgenCTrajectoriesCliHelpText);
    expect(skills.parseAgenCSkillsCliArgs).toBe(skillsArgs.parseAgenCSkillsCliArgs);
    expect(skills.formatAgenCSkillsCliHelpText).toBe(skillsArgs.formatAgenCSkillsCliHelpText);
    expect(skills.SKILL_CANDIDATES_LISTING_KIND).toBe("agenc.skills.candidates");
    expect(evaluations).toMatchObject({ mcp: 1, doctor: 1, trajectories: 1, skills: 1 });
  });

  // Exact UTF-8 output pinned from the pre-extraction facade implementations at
  // aaf332b45d0ec7b2f6f7b6e223b5648c8bab2d6d, not generated from the new leaves.
  // The doctor and trajectories hashes were re-pinned when their help copy
  // dropped em dashes on purpose.
  it.each([
    [mcpArgs.formatAgenCMcpCliHelpText, "21613cd36317296cb82c71adc4d5b409c5cf335237eb48f721421e93b68e3a8e"],
    [doctorArgs.formatAgenCDoctorCliHelpText, "bfca5950e52f64e51e1886c1e054101f17024f3302c6b493b7f31bdd4fa08b8a"],
    [trajectoryArgs.formatAgenCTrajectoriesCliHelpText, "f277b4824a353d6a57f219703f57118accf06a89e3334c9c5e1d3c80a55f5552"],
    [skillsArgs.formatAgenCSkillsCliHelpText, "b5c2fecf62ce0cfe2fd1e41a46a32ad638724ae581c02a3bb7837bfa574e6902"],
  ] as const)("preserves exact pre-extraction help bytes (%#)", (format, hash) => {
    expect(createHash("sha256").update(format()).digest("hex")).toBe(hash);
  });

  it("preserves MCP routing, readonly arguments, defaults, and invalid-input errors", () => {
    const parse = mcpArgs.parseAgenCMcpCliArgs;
    const argv = Object.freeze(["mcp", "list", "--json"]);
    expect(parse(argv)).toEqual({ kind: "management", argv: ["list", "--json"] });
    expect(argv).toEqual(["mcp", "list", "--json"]);
    expect(parse(["other"])).toBeNull();
    expect(parse(["mcp"])).toEqual({ kind: "help", text: mcpArgs.formatAgenCMcpCliHelpText() });
    expect(parse(["mcp", "serve"])).toEqual({ kind: "serve", transport: "stdio", host: "127.0.0.1", port: 3334 });
    expect(mcpArgs.parseMcpServeArgs(["--transport=sse"])).toEqual({ kind: "serve", transport: "sse", host: "127.0.0.1", port: 3334 });
    expect(parse(["mcp", "wat"])).toEqual({ kind: "error", message: "unknown mcp command: wat" });
    expect(parse(["mcp", "serve", "--transport"])).toEqual({ kind: "error", message: "--transport must be 'stdio' or 'sse'" });
    expect(parse(["mcp", "serve", "--host=elsewhere"])).toEqual({ kind: "error", message: "mcp serve only accepts --transport" });
    expect(parse(["mcp", "serve", "unexpected"])).toEqual({ kind: "error", message: "mcp serve does not accept argument 'unexpected'" });
  });

  it("preserves doctor help, options and conflicts", () => {
    const parse = doctorArgs.parseAgenCDoctorCliArgs;
    expect(parse(["other"])).toBeNull();
    expect(parse(["doctor"])).toEqual({ kind: "doctor", json: false });
    expect(parse(["doctor", "--json", "--json"])).toEqual({ kind: "doctor", json: true });
    expect(parse(["doctor", "--apparmor-profile"])).toEqual({ kind: "apparmor-profile" });
    expect(parse(["doctor", "-h"])).toEqual({ kind: "help", text: doctorArgs.formatAgenCDoctorCliHelpText() });
    expect(parse(["doctor", "--json", "--apparmor-profile"])).toEqual({ kind: "error", message: "doctor command cannot combine '--json' and '--apparmor-profile'" });
    expect(parse(["doctor", "wat"])).toEqual({ kind: "error", message: "doctor command does not accept argument 'wat'" });
  });

  it("preserves trajectory defaults, both option forms and rejected inputs", () => {
    const parse = trajectoryArgs.parseAgenCTrajectoriesCliArgs;
    expect(parse(["other"])).toBeNull();
    expect(parse(["trajectories"])).toEqual({ kind: "help", text: trajectoryArgs.formatAgenCTrajectoriesCliHelpText() });
    expect(parse(["trajectories", "export"])).toEqual({ kind: "export", format: "sft" });
    expect(parse(["trajectories", "export", "--format=dpo", "--dir", "input", "--out=output"])).toEqual({ kind: "export", format: "dpo", dir: "input", out: "output" });
    expect(parse(["trajectories", "wat"])).toEqual({ kind: "error", message: "unknown trajectories command: wat" });
    expect(parse(["trajectories", "export", "--format=bad"])).toEqual({ kind: "error", message: "trajectories export --format must be 'sft' or 'dpo', got 'bad'" });
    expect(parse(["trajectories", "export", "--dir", "--out=x"])).toEqual({ kind: "error", message: "trajectories export --dir requires a path" });
    expect(parse(["trajectories", "export", "--out="])).toEqual({ kind: "error", message: "trajectories export --out requires a path" });
  });

  it("preserves skills fallback versus candidate errors and canonical slug policy", async () => {
    const candidates = await import("../../src/skills/skill-candidates.js");
    expect(candidates.isValidSkillCandidateSlug).toBe(skillNames.isValidSkillCandidateSlug);
    expect(candidates.SKILL_CANDIDATES_DIR_NAME).toBe(skillNames.SKILL_CANDIDATES_DIR_NAME);
    expect(candidates.SKILL_CANDIDATES_LEDGER_FILE).toBe(skillNames.SKILL_CANDIDATES_LEDGER_FILE);
    expect(candidates.SKILL_CANDIDATES_ENV).toBe(skillNames.SKILL_CANDIDATES_ENV);
    const parse = skillsArgs.parseAgenCSkillsCliArgs;
    expect(parse(["other"])).toBeNull();
    expect(parse(["skills", "list", "--unknown"])).toBeNull();
    expect(parse(["skills", "list", "--json"])).toEqual({ kind: "list", json: true });
    expect(parse(["skills", "candidates", "list", "--json"])).toEqual({ kind: "candidates-list", json: true });
    for (const action of ["show", "accept", "reject"]) {
      expect(parse(["skills", "candidates", action, "good-name"])).toEqual({ kind: `candidates-${action}`, slug: "good-name" });
      expect(parse(["skills", "candidates", action])).toEqual({ kind: "error", message: `skills candidates ${action} needs a candidate name` });
    }
    for (const slug of ["ab", "a".repeat(65), "../abc", "ABC", "bad--name"]) {
      expect(skillNames.isValidSkillCandidateSlug(slug)).toBe(false);
      expect(parse(["skills", "candidates", "accept", slug])).toEqual({ kind: "error", message: `not a skill candidate name (kebab-case letters, digits, hyphens): ${slug}` });
    }
    expect(skillNames.isValidSkillCandidateSlug("abc")).toBe(true);
    expect(skillNames.isValidSkillCandidateSlug("a".repeat(64))).toBe(true);
  });

  it("keeps canonical trajectory constants and error-net function reexports", async () => {
    const trajectories = await import("../../src/session/trajectory-export.js");
    expect(trajectories.AGENC_TRAJECTORY_EXPORT_PATH_ENV).toBe(trajectoryNames.AGENC_TRAJECTORY_EXPORT_PATH_ENV);
    expect(trajectories.AGENC_TRAJECTORY_EXPORT_DIR_ENV).toBe(trajectoryNames.AGENC_TRAJECTORY_EXPORT_DIR_ENV);
    expect(trajectoryNames.AGENC_TRAJECTORY_EXPORT_PATH_ENV).toBe("AGENC_TRAJECTORY_EXPORT_PATH");
    expect(trajectoryNames.AGENC_TRAJECTORY_EXPORT_DIR_ENV).toBe("AGENC_TRAJECTORY_EXPORT_DIR");
    const facade = await import("../../src/utils/gracefulShutdown.js");
    const leaf = await import("../../src/utils/global-error-net.js");
    expect(facade.installGlobalErrorNet).toBe(leaf.installGlobalErrorNet);
  });
});
