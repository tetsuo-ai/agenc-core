import { CLI_ROUTES } from "./routes.js";
import { buildHelp, parseArgv } from "./foundation.js";
import {
  createContext,
  DEFAULT_LOG_LEVEL,
  normalizeLogLevel,
  normalizeOutputFormat,
} from "./shared.js";
import type { CliStatusCode } from "./types.js";

interface CliRunOptions {
  argv?: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export { parseArgv } from "./foundation.js";
export type { ParsedArgv } from "./foundation.js";

export async function runCli(
  options: CliRunOptions = {},
): Promise<CliStatusCode> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseArgv(argv);
  const outputFormat = normalizeOutputFormat(
    parsed.flags.output ?? parsed.flags["output-format"],
  );

  const context = createContext(
    stdout,
    stderr,
    outputFormat,
    normalizeLogLevel(process.env.AGENC_RUNTIME_LOG_LEVEL ?? DEFAULT_LOG_LEVEL),
  );

  const showRootHelp =
    parsed.flags.help || parsed.flags.h || parsed.positional.length === 0;
  if (showRootHelp) {
    context.output(buildHelp());
    return 0;
  }

  for (const route of CLI_ROUTES) {
    if (!route.matches(parsed)) {
      continue;
    }
    const module = await route.load();
    const status = await module.run({ parsed, context, stdout, stderr });
    if (status !== null) {
      return status;
    }
  }

  return 1;
}
