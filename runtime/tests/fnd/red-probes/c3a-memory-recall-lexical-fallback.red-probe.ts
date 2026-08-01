import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findRelevantMemories } from "../../../src/memory/find-relevant.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "c3a-memory-recall-lexical-fallback",
    task: "C3a",
    fingerprint: "C3A:MEMORY:LEXICAL-FALLBACK-ON-ADMISSION-DENIAL",
  });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-red-"));
  const targetPath = join(temporaryRoot, "quantum-flux.md");
  let selectedPaths: readonly string[] = Object.freeze([]);

  try {
    await writeFile(
      targetPath,
      "---\ndescription: Quantum flux capacitor calibration\ntype: user\n---\nUse the quantum flux capacitor calibration sequence.\n",
      { mode: 0o600 },
    );
    const selected = await findRelevantMemories(
      "quantum flux capacitor calibration",
      temporaryRoot,
      new AbortController().signal,
    );
    selectedPaths = Object.freeze(selected.map((memory) => memory.path));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  expectDeepStrictEqualRedProbe(
    probeIdentity,
    selectedPaths,
    Object.freeze([targetPath]),
  );
}
