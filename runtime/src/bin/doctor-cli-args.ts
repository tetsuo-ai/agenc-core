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
