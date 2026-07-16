import { EvalExecutorError } from "./source-lock.js";

export const PARSE_RESULT_SENTINEL = "AGENC_PARSE_RESULT:";

/**
 * Wrap the bundle's frozen `parser(log: str) -> dict[str, str]` source in a
 * harness that reads the first existing candidate log file and prints one
 * sentinel-prefixed JSON line. The combined program runs with python3 inside
 * the task container (`--network none`), never on the host.
 */
export function buildParserProgram(logParserSource: string): string {
  return [
    logParserSource,
    "",
    "if __name__ == '__main__':",
    "    import json as _agenc_json",
    "    import sys as _agenc_sys",
    "    _agenc_log = None",
    "    for _agenc_path in _agenc_sys.argv[1:]:",
    "        try:",
    "            with open(_agenc_path, 'r', errors='replace') as _agenc_file:",
    "                _agenc_log = _agenc_file.read()",
    "            break",
    "        except OSError:",
    "            continue",
    "    if _agenc_log is None:",
    "        raise SystemExit('no candidate log file was readable')",
    "    _agenc_results = parser(_agenc_log)",
    "    if not isinstance(_agenc_results, dict):",
    "        raise SystemExit('parser did not return a dict')",
    `    print(${JSON.stringify(PARSE_RESULT_SENTINEL)} + _agenc_json.dumps(`,
    "        {str(_agenc_key): str(_agenc_value) for _agenc_key, _agenc_value in _agenc_results.items()}))",
    "",
  ].join("\n");
}

/** Extract the sentinel-prefixed result line emitted by the parser harness. */
export function extractParserResults(stdout: string): Readonly<Record<string, string>> {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(PARSE_RESULT_SENTINEL));
  if (!line) {
    throw new EvalExecutorError(["parser harness produced no sentinel result line"]);
  }
  let value: unknown;
  try {
    value = JSON.parse(line.slice(PARSE_RESULT_SENTINEL.length));
  } catch (error) {
    throw new EvalExecutorError([
      `parser result line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvalExecutorError(["parser result must be a JSON object"]);
  }
  const results: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new EvalExecutorError([`parser result for ${key} must be a string status`]);
    }
    results[key] = entry;
  }
  return results;
}

/**
 * The 30 pilot bundles' parsers emit a heterogeneous status vocabulary:
 * `pass`/`passed`/`passes`/`PASS`/`PASSED`/`ok` on the passing side and
 * fail/error/skip variants otherwise (surveyed 2026-07-16 across the frozen
 * source lock). Match passing statuses case-insensitively and anchored;
 * anything unknown counts as NOT passed, so vocabulary drift disqualifies a
 * candidate loudly instead of silently qualifying one.
 */
const PASSED_STATUS_PATTERN = /^(?:pass(?:ed|es)?|ok)$/iu;

export function testPassed(results: Readonly<Record<string, string>>, testName: string): boolean {
  const status = results[testName];
  return status !== undefined && PASSED_STATUS_PATTERN.test(status.trim());
}
