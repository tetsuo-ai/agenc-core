import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create as createTar } from "tar";

import { assertCanonicalNpmPackageModes } from "../../../scripts/check-clean-build.mjs";

async function writePackageTarball(packageRoot, tarball) {
  await createTar(
    {
      cwd: packageRoot,
      file: tarball,
      gzip: true,
      portable: true,
      prefix: "package/",
    },
    ["package.json", "README.md", "bin", "dist"],
  );
}

test("npm package modes honor declared non-bin executables", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-package-modes-"));
  const packageRoot = join(root, "package");
  const validTarball = join(root, "valid.tgz");
  const invalidTarball = join(root, "invalid.tgz");
  try {
    mkdirSync(join(packageRoot, "bin"), { recursive: true, mode: 0o755 });
    mkdirSync(join(packageRoot, "dist"), { recursive: true, mode: 0o755 });
    writeFileSync(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "@tetsuo-ai/mode-fixture",
        bin: { fixture: "bin/fixture" },
        agencExecutableFiles: ["dist/process-broker"],
      })}\n`,
      { mode: 0o644 },
    );
    writeFileSync(join(packageRoot, "README.md"), "fixture\n", { mode: 0o644 });
    writeFileSync(join(packageRoot, "bin", "fixture"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    writeFileSync(join(packageRoot, "dist", "process-broker"), "binary\n", {
      mode: 0o755,
    });
    for (const directory of [
      join(packageRoot, "bin"),
      join(packageRoot, "dist"),
    ]) {
      chmodSync(directory, 0o755);
    }
    for (const file of [
      join(packageRoot, "package.json"),
      join(packageRoot, "README.md"),
    ]) {
      chmodSync(file, 0o644);
    }
    chmodSync(join(packageRoot, "bin", "fixture"), 0o755);
    chmodSync(join(packageRoot, "dist", "process-broker"), 0o755);

    await writePackageTarball(packageRoot, validTarball);
    await assert.doesNotReject(
      assertCanonicalNpmPackageModes(validTarball, packageRoot),
    );

    chmodSync(join(packageRoot, "dist", "process-broker"), 0o644);
    await writePackageTarball(packageRoot, invalidTarball);
    await assert.rejects(
      assertCanonicalNpmPackageModes(invalidTarball, packageRoot),
      /package\/dist\/process-broker:644 \(expected 755\)/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
