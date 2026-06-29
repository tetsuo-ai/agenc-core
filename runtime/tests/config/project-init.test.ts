import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildProjectInstructionsFromAnalysis } from "./project-init.js";

describe("project-init analysis", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function tempProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agenc-project-init-"));
    tempDirs.push(dir);
    return dir;
  }

  it("builds tailored project instructions from manifests and layout", async () => {
    const cwd = await tempProject();
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "tests"));
    await writeFile(
      join(cwd, "README.md"),
      [
        "# Example Service",
        "",
        "Requires EXAMPLE_API_KEY for integration tests.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          name: "example-service",
          type: "module",
          packageManager: "npm@11.0.0",
          engines: { node: ">=25" },
          scripts: {
            build: "tsc",
            test: "vitest run",
            lint: "eslint .",
          },
          devDependencies: { vitest: "^3.0.0" },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(join(cwd, "tsconfig.json"), "{}", "utf8");

    const instructions = await buildProjectInstructionsFromAnalysis(cwd);

    expect(instructions).toContain("Project/package name: example-service");
    expect(instructions).toContain("`npm run build`");
    expect(instructions).toContain("`npm run test`");
    expect(instructions).toContain("`src/` contains source code");
    expect(instructions).toContain("TypeScript is configured");
    expect(instructions).toContain("Vitest appears to be the test runner");
    expect(instructions).toContain("`EXAMPLE_API_KEY`");
    expect(instructions).not.toContain("Fill this file");
  });
});
