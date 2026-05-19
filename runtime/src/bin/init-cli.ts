import { cwd as processCwd } from "node:process";
import {
  formatProjectInitResult,
  initializeAgenCProject,
} from "../config/project-init.js";

export type AgenCInitCliCommand =
  | { readonly kind: "init"; readonly force: boolean }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCInitCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCInitCliOptions {
  readonly cwd?: string;
  readonly io?: AgenCInitCliIo;
}

export function formatAgenCInitCliHelpText(): string {
  return [
    "Usage: agenc init [--force]",
    "",
    "Creates project-level AgenC files in the current directory:",
    "  .agenc/config.json",
    "  AGENC.md",
    "",
    "Options:",
    "  --force     Overwrite existing AgenC project files",
    "  -h, --help  Show this help text",
    "",
    "Examples:",
    "  agenc init",
    "  agenc init --force",
  ].join("\n");
}

export function parseAgenCInitCliArgs(
  argv: readonly string[],
): AgenCInitCliCommand | null {
  if (argv[0] !== "init") return null;
  let force = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCInitCliHelpText() };
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    return {
      kind: "error",
      message: `init command does not accept argument '${arg}'`,
    };
  }
  return { kind: "init", force };
}

export async function runAgenCInitCli(
  command: AgenCInitCliCommand,
  options: AgenCInitCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCInitCliHelpText()}\n`);
      return 1;
    case "init":
      try {
        const result = await initializeAgenCProject({
          cwd: options.cwd ?? processCwd(),
          force: command.force,
        });
        io.stdout.write(`${formatProjectInitResult(result)}\n`);
        return 0;
      } catch (error) {
        io.stderr.write(
          `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
  }
}
