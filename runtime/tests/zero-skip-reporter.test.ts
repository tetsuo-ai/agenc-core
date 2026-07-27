import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  readZeroSkipEvidence,
  ZERO_SKIP_REPORT_ENV_VAR,
} from "../scripts/zero-skip-reporter.mjs";

const CHILD_MODE = "AGENC_TEST_ZERO_SKIP_CHILD_MODE";
const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const prelauncher = fileURLToPath(
  new URL("../scripts/run-hermetic-vitest.mjs", import.meta.url),
);
const boundary = fileURLToPath(
  new URL("../scripts/run-hermetic-test-boundary.mjs", import.meta.url),
);

if (process.env[CHILD_MODE] === "passing") {
  describe("zero-skip passing fixture", () => {
    it("runs without seeing coordinator evidence state", () => {
      expect(process.env[ZERO_SKIP_REPORT_ENV_VAR]).toBeUndefined();
    });
  });
} else if (process.env[CHILD_MODE] === "skipped") {
  describe("zero-skip skipped fixture", () => {
    it.skip("is reported by exact identity", () => undefined);
  });
} else {
  describe("zero-skip reporter contract", () => {
    function runNested(
      mode: "passing" | "skipped",
      options: { reporter?: boolean } = {},
    ) {
      return spawnSync(
        process.execPath,
        [
          prelauncher,
          "--require-zero-skips",
          "run",
          "tests/zero-skip-reporter.test.ts",
          "--config",
          "vitest.config.ts",
          ...(options.reporter === false ? [] : ["--reporter=dot"]),
        ],
        {
          cwd: runtimeRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            [CHILD_MODE]: mode,
          },
          timeout: 30_000,
        },
      );
    }

    it("preserves requested reporters while forcing zero-skip evidence", () => {
      const result = runNested("passing");

      expect(
        result.status,
        `nested zero-skip pass failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        "zero-skip evidence was missing or unreadable",
      );
    });

    it("retains the default reporter when no reporter was requested", () => {
      const result = runNested("passing", { reporter: false });

      expect(
        result.status,
        `nested zero-skip pass failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain("Test Files");
      expect(result.stdout).toContain("Tests");
    });

    it("fails with the exact identity of every skipped test", () => {
      const result = runNested("skipped");
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain(
        "Hermetic Vitest requires zero skipped tests; observed 1",
      );
      expect(output).toContain(
        "tests/zero-skip-reporter.test.ts > zero-skip skipped fixture > is reported by exact identity [skip]",
      );
    });

    it("rejects missing and malformed evidence", () => {
      const root = mkdtempSync(join(tmpdir(), "agenc-zero-skip-evidence-"));
      try {
        expect(() =>
          readZeroSkipEvidence(join(root, "missing.json")),
        ).toThrow();

        const malformed = join(root, "malformed.json");
        writeFileSync(malformed, "{", { mode: 0o600 });
        expect(() => readZeroSkipEvidence(malformed)).toThrow();

        const invalidSchema = join(root, "invalid-schema.json");
        writeFileSync(
          invalidSchema,
          JSON.stringify({ schemaVersion: 1, skippedTests: [{}] }),
          { mode: 0o600 },
        );
        expect(() => readZeroSkipEvidence(invalidSchema)).toThrow(
          "zero-skip report entry 0 is invalid",
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });

    it("keeps zero-skip enforcement on the authoritative boundary", () => {
      expect(readFileSync(boundary, "utf8")).toContain(
        "run-hermetic-vitest.mjs --require-zero-skips",
      );
    });
  });
}
