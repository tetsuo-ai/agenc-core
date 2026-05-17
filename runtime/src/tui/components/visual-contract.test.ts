import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentsRoot = fileURLToPath(new URL(".", import.meta.url));

function listSourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (
      !/\.(?:[jt]sx?|mjs)$/u.test(entry.name) ||
      /\.d\.ts$/u.test(entry.name) ||
      /\.test\.[jt]sx?$/u.test(entry.name)
    ) {
      return [];
    }
    return [fullPath];
  });
}

describe("TUI visual contract", () => {
  it("keeps component chrome terminal-renderable and theme-tokenized", () => {
    const violations = listSourceFiles(componentsRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const rel = relative(process.cwd(), file);
      const checks = [
        [/borderStyle\s*=\s*(?:["']round["']|\{\s*["']round["']\s*\})/u, "round border"],
        [/["'`]#[0-9a-fA-F]{3,8}\b/u, "inline hex color"],
        [/\brgba\s*\(/u, "inline rgba color"],
        [/\b(?:linear|radial)-gradient\s*\(/u, "gradient"],
        [/\bboxShadow\b/u, "box shadow"],
        [/\bbackdropFilter\b/u, "backdrop blur"],
        [/\bborderRadius\b/u, "rounded corner"],
        [/\buseAnimationFrame\b/u, "timer-driven visual animation"],
        [/\buseBlink\b/u, "non-caret blink animation"],
      ] as const;

      return checks.flatMap(([pattern, label]) =>
        pattern.test(source) ? [`${rel}: ${label}`] : [],
      );
    });

    expect(violations).toEqual([]);
  });
});
