import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import {
  assertCompactionOfflineAcceptance,
  deterministicCompactionOfflineProjection,
  validateCompactionOfflineReport,
} from "./offline-contract.mjs";
import {
  evaluateCompactionOfflineCorpus,
  loadCompactionOfflineCorpus,
} from "./offline-evaluator.mjs";

const RESULT_URL = new URL("./offline-results.v1.json", import.meta.url);

export async function runCompactionOfflineEvaluation(args = process.argv.slice(2)) {
  const flags = new Set(args);
  for (const flag of flags) {
    if (flag !== "--check" && flag !== "--write") throw new Error(`unknown argument ${flag}`);
  }
  if (flags.has("--check") && flags.has("--write")) {
    throw new Error("--check and --write are mutually exclusive");
  }
  const { corpus, sha256 } = await loadCompactionOfflineCorpus();
  const report = evaluateCompactionOfflineCorpus(corpus, sha256);
  if (flags.has("--write")) {
    await writeFile(RESULT_URL, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { mode: "write", report };
  }
  if (flags.has("--check")) {
    const committed = validateCompactionOfflineReport(
      JSON.parse(await readFile(RESULT_URL, "utf8")),
    );
    const actualProjection = deterministicCompactionOfflineProjection(report);
    const committedProjection = deterministicCompactionOfflineProjection(committed);
    if (!isDeepStrictEqual(actualProjection, committedProjection)) {
      throw new Error(
        "committed offline compaction result is stale; review the corpus/candidate change and rerun with --write",
      );
    }
    assertCompactionOfflineAcceptance(report);
    return { mode: "check", report };
  }
  return { mode: "run", report };
}

async function main() {
  const result = await runCompactionOfflineEvaluation();
  process.stdout.write(`${JSON.stringify(result.report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
