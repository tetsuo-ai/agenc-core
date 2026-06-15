import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverInstructionRules,
  parseRuleFile,
  projectRulesDir,
  ruleMatchesTarget,
} from "./discovery.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agenc-rules-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseRuleFile", () => {
  test("parses paths/globs frontmatter and strips it from content", () => {
    const parsed = parseRuleFile(`---
paths:
  - src
globs: ["*.ts", "tests/**"]
alwaysApply: false
description: scoped
---
# Rule
`);
    expect(parsed.frontmatter.paths).toEqual(["src"]);
    expect(parsed.frontmatter.globs).toEqual(["*.ts", "tests/**"]);
    expect(parsed.frontmatter.description).toBe("scoped");
    expect(parsed.body).toBe("# Rule");
  });
});

describe("ruleMatchesTarget", () => {
  test("matches relative path and glob patterns", () => {
    const rulePath = join(dir, ".agenc", "rules", "typescript.md");
    const fm = {
      paths: ["src"],
      globs: ["tests/**/*.test.ts"],
      alwaysApply: false,
      extra: {},
    };
    expect(ruleMatchesTarget(rulePath, fm, join(dir, "src", "index.ts"))).toBe(true);
    expect(ruleMatchesTarget(rulePath, fm, join(dir, "tests", "unit", "x.test.ts"))).toBe(true);
    expect(ruleMatchesTarget(rulePath, fm, join(dir, "docs", "x.md"))).toBe(false);
  });

  test("matches project-relative patterns for nested rule files", () => {
    const rulePath = join(dir, ".agenc", "rules", "frontend", "typescript.md");
    const fm = {
      paths: ["src"],
      globs: ["tests/**/*.test.ts"],
      alwaysApply: false,
      extra: {},
    };
    expect(ruleMatchesTarget(rulePath, fm, join(dir, "src", "index.ts"))).toBe(true);
    expect(ruleMatchesTarget(rulePath, fm, join(dir, "tests", "unit", "x.test.ts"))).toBe(true);
    expect(ruleMatchesTarget(rulePath, fm, join(dir, "docs", "x.md"))).toBe(false);
  });
});

describe("discoverInstructionRules", () => {
  test("returns unconditional rules when no path frontmatter is present", async () => {
    const rulesDir = projectRulesDir(dir);
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "always.md"), "# Always\n");
    const rules = await discoverInstructionRules({
      rulesDir,
      type: "Project",
      boundaryDir: dir,
      includeUnconditional: true,
      includeConditional: false,
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.content).toBe("# Always");
  });

  test("returns conditional rules only for matching targets", async () => {
    const rulesDir = projectRulesDir(dir);
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "src.md"), `---
globs: ["src/**/*.ts"]
---
# Src
`);
    const rules = await discoverInstructionRules({
      rulesDir,
      type: "Project",
      boundaryDir: dir,
      targetPath: join(dir, "src", "nested", "x.ts"),
      includeUnconditional: false,
      includeConditional: true,
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.content).toBe("# Src");
  });

  test("returns matching conditional rules from nested rule directories", async () => {
    const rulesDir = projectRulesDir(dir);
    const nestedRulesDir = join(rulesDir, "frontend");
    mkdirSync(nestedRulesDir, { recursive: true });
    writeFileSync(join(nestedRulesDir, "src.md"), `---
globs: ["src/**/*.ts"]
---
# Nested Src
`);
    const rules = await discoverInstructionRules({
      rulesDir,
      type: "Project",
      boundaryDir: dir,
      targetPath: join(dir, "src", "nested", "x.ts"),
      includeUnconditional: false,
      includeConditional: true,
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.content).toBe("# Nested Src");
  });
});
