import type { Command } from "../../types/command.js";
import {
  getBuiltinPluginSkillCommands as readRegisteredSkillCommands,
  registerBuiltinPlugin,
} from "../builtinPlugins.js";
import {
  resolveShippedPluginDir,
  shippedPluginSkill,
} from "./repositoryPluginSkill.js";

let initialized = false;

/**
 * Register the plugins that ship inside the runtime package.
 *
 * These are deliberately NOT subject to `plugins.enabled`. That flag gates
 * AUTO-DISCOVERY — loading whatever `plugins/` directory the repository you
 * happen to open contains, which a third party can forge and which can carry
 * hooks that execute commands. It stays off by default and this does not
 * change it. A plugin shipped in the runtime package is code we published, so
 * it is registered here and enabled by default like any other first-party
 * surface; a user can still turn it off in /plugin, which wins over this.
 *
 * Idempotent: the daemon and the CLI both reach startup paths that call it.
 */
export function initBuiltinPlugins(): void {
  if (initialized) return;
  initialized = true;

  const zerodayHunter = shippedPluginSkill({
    pluginName: "zeroday-hunter",
    description:
      "Exploit-first 0-day hunting in source code: a campaign state machine " +
      "(frame → map → audit → prove → falsify → report) with quantitative " +
      "gates, deterministic PoC verification and hashed evidence.",
    whenToUse:
      "The user asks to audit code for vulnerabilities, hunt 0-days, do " +
      "security research, find exploitable bugs, or run a vuln-discovery " +
      "campaign on a codebase they own or are authorized to test.",
    argumentHint: "<target-path> [bug-class|watch]",
  });

  // Null when the plugin directory is absent (a trimmed install). Registering
  // a plugin with no skills would show an empty entry in /plugin, so skip it
  // entirely and let the surface simply not be offered.
  if (zerodayHunter !== null) {
    const pluginRoot = resolveShippedPluginDir("zeroday-hunter");
    if (pluginRoot === null) return;
    registerBuiltinPlugin({
      root: pluginRoot,
      skills: [zerodayHunter],
    });
  }
}

/** Test seam: allows a suite to re-register against a fresh registry. */
export function resetBuiltinPluginInit(): void {
  initialized = false;
}

/**
 * Command-source entry point. Registration is lazy and idempotent so the
 * registry is never read empty — the previous shape left `registerBuiltinPlugin`
 * with no caller at all, which is why nothing shipped in the package appeared.
 */
export function getBuiltinPluginSkillCommands(): Command[] {
  initBuiltinPlugins();
  return readRegisteredSkillCommands();
}
