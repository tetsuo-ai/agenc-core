import { tokenizeCliOptionRegion } from "./cli-option-region.js";
import { classifyCLI, type ClassifyCLIOptions, type RouteCLIPlan } from "./route.js";

export function startupShortCircuitFlag(
  argv: readonly string[],
): "help" | "version" | null {
  const { optionArgs } = tokenizeCliOptionRegion(argv);
  if (optionArgs.includes("--help") || optionArgs.includes("-h")) return "help";
  if (optionArgs.includes("--version")) return "version";
  return null;
}

export function preflightStartupArguments(
  argv: readonly string[],
  terminal: Pick<ClassifyCLIOptions, "isTTY" | "isStdoutTTY">,
): Extract<RouteCLIPlan, { kind: "errorAndExit" }> | null {
  if (startupShortCircuitFlag(argv) !== null) return null;
  const plan = classifyCLI({ argv: ["node", "agenc", ...argv], ...terminal });
  return plan.kind === "errorAndExit" ? plan : null;
}
