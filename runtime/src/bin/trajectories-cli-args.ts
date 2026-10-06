import {
  AGENC_TRAJECTORY_EXPORT_PATH_ENV,
  AGENC_TRAJECTORY_EXPORT_DIR_ENV,
} from "../session/trajectory-export-constants.js";

export type TrajectoryExportFormat = "sft" | "dpo";

export type AgenCTrajectoriesCliCommand =
  | {
      readonly kind: "export";
      readonly format: TrajectoryExportFormat;
      readonly dir?: string;
      readonly out?: string;
    }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function formatAgenCTrajectoriesCliHelpText(): string {
  return [
    "Usage: agenc trajectories export [options]",
    "",
    "Curate the redacted trajectory exports written by the session sink",
    "(enable with AGENC_TRAJECTORY_EXPORT_DIR=<dir>, then run sessions)",
    "into training-data JSONL. Local file processing only, no network.",
    "",
    "Only trajectories that completed at least one turn with no error",
    "event, no abort/interrupt, and no user tool-use rejection are kept.",
    "",
    "Options:",
    "  --format <sft|dpo>  Output format (default: sft)",
    "                        sft: one chat-schema conversation per row",
    "                        dpo: prompt/chosen/rejected preference pairs",
    "                             derived from thread-rollback regenerations",
    "  --dir <path>        Export dir (or single .jsonl file) to read.",
    `                      Default: $${AGENC_TRAJECTORY_EXPORT_DIR_ENV},`,
    `                      then $${AGENC_TRAJECTORY_EXPORT_PATH_ENV}`,
    "  --out <file>        Write JSONL here instead of stdout",
    "  -h, --help          Show this help text",
    "",
    "Note: --require-eval-passed is not available. Exported records",
    "carry no evaluation outcome field to filter on.",
  ].join("\n");
}

export function parseAgenCTrajectoriesCliArgs(
  argv: readonly string[],
): AgenCTrajectoriesCliCommand | null {
  if (argv[0] !== "trajectories") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCTrajectoriesCliHelpText() };
  }
  if (action !== "export") {
    return {
      kind: "error",
      message: `unknown trajectories command: ${action}`,
    };
  }

  let format: TrajectoryExportFormat = "sft";
  let dir: string | undefined;
  let out: string | undefined;
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCTrajectoriesCliHelpText() };
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg.includes("=") ? arg.slice("--format=".length) : rest[++i];
      if (value !== "sft" && value !== "dpo") {
        return {
          kind: "error",
          message: `trajectories export --format must be 'sft' or 'dpo', got '${value ?? ""}'`,
        };
      }
      format = value;
      continue;
    }
    if (arg === "--dir" || arg.startsWith("--dir=")) {
      const value = arg.includes("=") ? arg.slice("--dir=".length) : rest[++i];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        return {
          kind: "error",
          message: "trajectories export --dir requires a path",
        };
      }
      dir = value;
      continue;
    }
    if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg.includes("=") ? arg.slice("--out=".length) : rest[++i];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        return {
          kind: "error",
          message: "trajectories export --out requires a path",
        };
      }
      out = value;
      continue;
    }
    return {
      kind: "error",
      message: `trajectories export does not accept argument '${arg}'`,
    };
  }

  return {
    kind: "export",
    format,
    ...(dir !== undefined ? { dir } : {}),
    ...(out !== undefined ? { out } : {}),
  };
}
