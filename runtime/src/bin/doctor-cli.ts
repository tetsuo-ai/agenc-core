/**
 * `agenc doctor` — top-level environment/installation diagnostics.
 *
 * Surfaces the diagnostic that previously had no top-level entry point
 * (only `agenc mcp doctor` was wired) by formatting
 * {@link getDoctorDiagnostic}. For MCP-server-specific diagnostics, see
 * `agenc mcp doctor`.
 */
import { renderAgenCAppArmorProfile } from "../sandbox/apparmor.js";
import {
  findActiveGeneratedWrapper,
  getDoctorDiagnostic,
} from "../utils/doctorDiagnostic.js";

export type AgenCDoctorCliCommand =
  | { readonly kind: "doctor"; readonly json: boolean }
  | { readonly kind: "apparmor-profile" }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export function formatAgenCDoctorCliHelpText(): string {
  return [
    "agenc doctor — diagnose the AgenC installation and environment",
    "",
    "Usage:",
    "  agenc doctor            Print installation, version, ripgrep, update,",
    "                          transaction-guard, and PATH/glob diagnostics",
    "                          with suggested fixes",
    "  agenc doctor --json     Emit the raw diagnostic as JSON",
    "  agenc doctor --apparmor-profile",
    "                          Print a narrow AppArmor user-namespace profile",
    "                          for this verified standalone installation",
    "",
    "Options:",
    "  --json              Emit JSON instead of text",
    "  --apparmor-profile  Print the AppArmor profile; do not install it",
    "  -h, --help          Show this help text",
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
  let json = false;
  let apparmorProfile = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCDoctorCliHelpText() };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--apparmor-profile") {
      apparmorProfile = true;
      continue;
    }
    return {
      kind: "error",
      message: `doctor command does not accept argument '${arg}'`,
    };
  }
  if (json && apparmorProfile) {
    return {
      kind: "error",
      message:
        "doctor command cannot combine '--json' and '--apparmor-profile'",
    };
  }
  if (apparmorProfile) return { kind: "apparmor-profile" };
  return { kind: "doctor", json };
}

export function formatDiagnosticText(
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
    `  Configured rg (TUI/legacy): ${
      info.ripgrepStatus.working ? "ok" : "NOT WORKING"
    } ` +
      `(${info.ripgrepStatus.mode}${
        info.ripgrepStatus.systemPath
          ? `: ${info.ripgrepStatus.systemPath}`
          : ""
      })`,
  );
  lines.push(
    `  Packaged rg (Grep/Glob/Orient): ${
      info.ripgrepStatus.grepPinnedWorking ? "ok" : "NOT WORKING"
    }`,
  );
  const guard = info.transactionGuard;
  lines.push(
    `  Transaction guard:  ${guard.enabled ? "enabled" : "disabled"} ` +
      `(source: ${guard.source}, fail-${guard.failMode})`,
  );
  if (guard.enabled) {
    lines.push(`    model:    ${guard.model}`);
    lines.push(
      `    endpoint: ${guard.endpoint} ` +
        `(${guard.endpointReachable ? "reachable" : "UNREACHABLE"})`,
    );
  }
  lines.push(
    `  Sandbox:            ${info.sandbox.kind} ` +
      `(mode: ${info.sandbox.mode}, platform: ${info.sandbox.platform})`,
  );
  if (info.sandbox.reason) {
    lines.push(`    reason:   ${info.sandbox.reason}`);
  }
  if (info.sandbox.landlock !== undefined) {
    const label =
      info.sandbox.landlock === "full"
        ? "fully enforced"
        : info.sandbox.landlock === "partial"
          ? "partially enforced (older kernel ABI)"
          : "unavailable";
    lines.push(`    landlock: ${label}`);
  }

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
  switch (command.kind) {
    case "help":
      process.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      process.stderr.write(`agenc: ${command.message}\n`);
      process.stderr.write(`${formatAgenCDoctorCliHelpText()}\n`);
      return 1;
    case "apparmor-profile": {
      const wrapper = await findActiveGeneratedWrapper();
      if (wrapper === null) {
        process.stderr.write(
          "agenc: --apparmor-profile requires a verified standalone-installer wrapper for this exact runtime\n" +
            "agenc: the profile grants the user-namespace exception to one exact binary path, so it is only\n" +
            "agenc: generated for the byte-verified wrapper the standalone installer manages. This runtime was\n" +
            "agenc: started from a source checkout or npm install, which has no such wrapper.\n" +
            "agenc: To sandbox on this machine, install the standalone build and run the command there, or see\n" +
            "agenc: your distribution's documentation for kernel.apparmor_restrict_unprivileged_userns.\n",
        );
        return 1;
      }
      process.stdout.write(renderAgenCAppArmorProfile(wrapper.path));
      return 0;
    }
    case "doctor": {
      const info = await getDoctorDiagnostic();
      if (command.json) {
        process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatDiagnosticText(info)}\n`);
      }
      return info.warnings.length > 0 ? 1 : 0;
    }
  }
}
