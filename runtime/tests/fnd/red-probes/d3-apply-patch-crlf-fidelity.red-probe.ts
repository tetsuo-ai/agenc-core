import type { RedProbeAssertion } from "../../helpers/red-probe.js";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPatchText } from "../../../src/tools/apply-patch/runtime.js";
import { workspaceMutationCoordinators } from "../../../src/workspace/mutation-coordinator.js";

export default async function runRedProbe(
  expectDeepStrictEqualRedProbe: RedProbeAssertion,
): Promise<void> {
  const probeIdentity = Object.freeze({
    id: "d3-apply-patch-crlf-fidelity",
    task: "D3",
    fingerprint: "D3:APPLY-PATCH:CRLF-FIDELITY",
  });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-d3-red-"));
  const targetPath = join(temporaryRoot, "target.txt");
  let observedContent = "";

  try {
    await writeFile(targetPath, "a\r\nb\r\n", { mode: 0o600 });
    await applyPatchText(
      "*** Begin Patch\n*** Update File: target.txt\n@@\n-b\n+c\n*** End Patch\n",
      { cwd: temporaryRoot, allowedPaths: [temporaryRoot] },
    );
    observedContent = await readFile(targetPath, "utf8");
  } finally {
    workspaceMutationCoordinators.clearForTests();
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  expectDeepStrictEqualRedProbe(probeIdentity, observedContent, "a\r\nc\r\n");
}
