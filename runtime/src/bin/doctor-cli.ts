/**
 * `agenc doctor` — top-level environment/installation diagnostics.
 *
 * Surfaces the diagnostic that previously had no top-level entry point
 * (only `agenc mcp doctor` was wired) by formatting
 * {@link getDoctorDiagnostic}. For MCP-server-specific diagnostics, see
 * `agenc mcp doctor`.
 */
import { getDoctorDiagnostic } from "../utils/doctorDiagnostic.js";

export interface AgenCDoctorCliCommand {
  readonly json: boolean;
}

export function formatAgenCDoctorCliHelpText(): string {
  return [
    "agenc doctor — diagnose the AgenC installation and environment",
    "",
    "Usage:",
    "  agenc doctor            Print installation, version, ripgrep, update,",
    "                          and PATH/glob diagnostics with suggested fixes",
    "  agenc doctor --json     Emit the raw diagnostic as JSON",
    "",
    "See also: agenc mcp doctor (MCP server configuration diagnostics)",
  ].join("\n");
}

/**
 * Parse argv for the top-level `doctor` command. Returns null when argv is
 * not a `doctor` invocation so the caller can fall through to other CLIs.
 */
export function parseAgenCDoctorCliArgs(
  argv: readonly string[],
): AgenCDoctorCliCommand | null {
  if (argv[0] !== "doctor") return null;
  const rest = argv.slice(1);
  const json = rest.includes("--json");
  return { json };
}

function formatDiagnosticText(
  info: Awaited<ReturnType<typeof getDoctorDiagnostic>>,
): string {
  const lines: string[] = [];
  lines.push("AgenC Doctor");
  lines.push("");
  lines.push(`  Version:            ${info.version}`);
  lines.push(`  Installation type:  ${info.installationType}`);
  lines.push(`  Installation path:  ${info.installationPath}`);
  lines.push(`  Invoked binary:     ${info.invokedBinary}`);
  if (info.packageManager) {
    lines.push(`  Package manager:    ${info.packageManager}`);
  }
  lines.push(`  Config install:     ${info.configInstallMethod}`);
  lines.push(`  Auto-updates:       ${info.autoUpdates}`);
  if (info.hasUpdatePermissions !== null) {
    lines.push(
      `  Update permissions: ${info.hasUpdatePermissions ? "yes" : "no"}`,
    );
  }
  lines.push(
    `  ripgrep:            ${info.ripgrepStatus.working ? "ok" : "NOT WORKING"} ` +
      `(${info.ripgrepStatus.mode}${
        info.ripgrepStatus.systemPath
          ? `: ${info.ripgrepStatus.systemPath}`
          : ""
      })`,
  );

  if (info.multipleInstallations.length > 0) {
    lines.push("");
    lines.push("  Multiple installations detected:");
    for (const install of info.multipleInstallations) {
      lines.push(`    - ${install.type}: ${install.path}`);
    }
  }

  if (info.warnings.length > 0) {
    lines.push("");
    lines.push(`  Warnings (${info.warnings.length}):`);
    for (const warning of info.warnings) {
      lines.push(`    ⚠ ${warning.issue}`);
      lines.push(`      fix: ${warning.fix}`);
    }
  } else {
    lines.push("");
    lines.push("  No warnings.");
  }

  if (info.recommendation) {
    lines.push("");
    lines.push(`  Recommendation: ${info.recommendation}`);
  }

  return lines.join("\n");
}

/**
 * Run the top-level doctor diagnostic. Returns a process exit code: 1 when
 * any warning is present (so scripts can gate on a clean environment), else 0.
 */
export async function runAgenCDoctorCli(
  command: AgenCDoctorCliCommand,
): Promise<number> {
  const info = await getDoctorDiagnostic();
  if (command.json) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDiagnosticText(info)}\n`);
  }
  return info.warnings.length > 0 ? 1 : 0;
}
