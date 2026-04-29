import process from "node:process";
import {
  describeRuntimeInstall,
  ensureRuntimeFromSource,
  ensureRuntimeInstalled,
  RuntimeInstallError,
  spawnInstalledRuntimeBin,
  spawnInstalledRuntimeBinFromSource,
  uninstallRuntime,
} from "./runtime-manager.js";

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

function buildAgencHelp() {
  return [
    "agenc [runtime-command] [options]",
    "agenc runtime <where|install|update|uninstall>",
    "",
    "Default behavior:",
    "  agenc opens the general shell over the local daemon.",
    "  agenc console opens the explicit shared TUI/cockpit surface.",
    "",
    "Primary entrypoints:",
    "  agenc",
    "  agenc shell coding",
    "  agenc console",
    "  agenc ui",
    "",
    "Common daemon-backed surfaces:",
    "  plan, agents, tasks, files, grep, git, branch, worktree, diff, review",
    "  session, permissions, mcp, skills, model, effort",
    "",
    "Examples:",
    "  agenc",
    "  agenc shell coding",
    "  agenc plan enter --objective \"Ship Phase 4\" --worktrees child",
    "  agenc agents roles",
    "  agenc session list --active-only",
    "  agenc mcp inspect demo",
    "  agenc skills inspect local-skill",
    "  agenc market skills list",
    "  agenc resume --profile coding",
    "  agenc review --staged --delegate",
    "  agenc console",
    "  agenc ui",
    "  agenc runtime where",
    "",
    "Marketplace / devnet examples:",
    "  agenc agent register --rpc https://api.devnet.solana.com",
    "  agenc market tasks create --description 'public task' --reward 50000000 --rpc https://api.devnet.solana.com",
    "  agenc market tui",
    "",
    "Supported public wrapper tuple:",
    "  Linux x64, Node >=18.0.0",
    "",
    "Compatibility alias:",
    "  agenc-runtime remains available after install, but public docs should use agenc.",
    "",
    "Dev / from-source:",
    "  agenc start --from-source",
    "  agenc start --from-source --source-dir /path/to/agenc-core/runtime",
    "    Builds runtime/dist locally and points ~/.agenc/runtime/current at it.",
  ].join("\n");
}

function buildAgencRuntimeHelp() {
  return [
    "agenc-runtime [runtime-command] [options]",
    "",
    "Compatibility alias for the installed AgenC runtime CLI.",
    "",
    "Dev flags:",
    "  --from-source              build the local agenc-core/runtime tree",
    "                             and run the daemon from there",
    "  --source-dir <path>        explicit runtime/ source path",
  ].join("\n");
}

async function runRuntimeAdmin(argv, io, deps, runtimeOptions) {
  const command = argv[0];
  const force = argv.includes("--force");
  if (!command || command === "help" || command === "--help" || command === "-h") {
    writeLine(
      io.stdout,
      "agenc runtime <where|install|update|uninstall> [--force]",
    );
    return 0;
  }

  if (command === "where") {
    const description = await deps.describeRuntimeInstall(runtimeOptions);
    writeLine(
      io.stdout,
      JSON.stringify(
        {
          runtimeHome: description.runtimeHome,
          installed: description.installed,
          releaseDir: description.releaseDir,
          currentDir: description.currentDir,
          manifestSource: description.manifestSource,
          manifestDigest: description.manifestDigest,
          trustPolicy: description.trustPolicy
            ? {
                wrapperVersion: description.trustPolicy.wrapperVersion,
                keyId: description.trustPolicy.keyId,
                releaseChannel: description.trustPolicy.releaseChannel ?? null,
                releaseRepository:
                  description.trustPolicy.releaseRepository ?? null,
                releaseTag: description.trustPolicy.releaseTag ?? null,
                revokedManifestDigests:
                  description.trustPolicy.revokedManifestDigests,
                revokedRuntimeVersions:
                  description.trustPolicy.revokedRuntimeVersions,
              }
            : null,
          selectedArtifact: description.selectedArtifact
            ? {
                runtimeVersion: description.selectedArtifact.runtimeVersion,
                platform: description.selectedArtifact.platform,
                arch: description.selectedArtifact.arch,
                nodeRange: description.selectedArtifact.nodeRange,
              }
            : null,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (command === "install" || command === "update") {
    const installation = await deps.ensureRuntimeInstalled({
      ...runtimeOptions,
      force: command === "update",
    });
    writeLine(
      io.stdout,
      `Installed AgenC runtime ${installation.selectedArtifact.runtimeVersion} at ${installation.releaseDir}`,
    );
    return 0;
  }

  if (command === "uninstall") {
    const result = await deps.uninstallRuntime({ ...runtimeOptions, force });
    writeLine(
      io.stdout,
      result.removed
        ? `Removed AgenC runtime at ${result.releaseDir}\nPreserved: ${result.preservedPaths.join(", ")}`
        : "No installed AgenC runtime found for the current platform",
    );
    return 0;
  }

  writeLine(io.stderr, `Unknown agenc runtime command: ${command}`);
  return 2;
}

const DEFAULT_DEPS = {
  ensureRuntimeInstalled,
  ensureRuntimeFromSource,
  describeRuntimeInstall,
  uninstallRuntime,
  spawnInstalledRuntimeBin,
  spawnInstalledRuntimeBinFromSource,
};

/**
 * Cut 6.1: detect and strip the `--from-source` flag (and the optional
 * `--source-dir <path>`) from the wrapper argv. Returns the remaining argv
 * plus the parsed flag values so the rest of the dispatcher can continue
 * to operate on a clean argument list.
 */
function extractFromSourceFlags(argv) {
  const remaining = [];
  let fromSource = false;
  let sourceDir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from-source") {
      fromSource = true;
      continue;
    }
    if (arg === "--source-dir" && i + 1 < argv.length) {
      sourceDir = argv[++i];
      fromSource = true;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--source-dir=")) {
      sourceDir = arg.slice("--source-dir=".length);
      fromSource = true;
      continue;
    }
    remaining.push(arg);
  }
  return { argv: remaining, fromSource, sourceDir };
}

function formatRuntimeInstallError(error) {
  if (error instanceof RuntimeInstallError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runAgencWrapper(options = {}, deps = DEFAULT_DEPS) {
  const rawArgv = options.argv ?? process.argv.slice(2);
  const { argv, fromSource, sourceDir } = extractFromSourceFlags(rawArgv);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runtimeOptions = {
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir,
    packageRoot: options.packageRoot,
    sourceDir,
  };

  try {
    if (argv[0] === "runtime") {
      return await runRuntimeAdmin(
        argv.slice(1),
        { stdout, stderr },
        deps,
        runtimeOptions,
      );
    }
    if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      writeLine(stdout, buildAgencHelp());
      return 0;
    }
    if (fromSource) {
      return await deps.spawnInstalledRuntimeBinFromSource(
        "agenc",
        argv,
        runtimeOptions,
      );
    }
    return await deps.spawnInstalledRuntimeBin("agenc", argv, runtimeOptions);
  } catch (error) {
    writeLine(stderr, formatRuntimeInstallError(error));
    return 1;
  }
}

export async function runAgencRuntimeWrapper(options = {}, deps = DEFAULT_DEPS) {
  const rawArgv = options.argv ?? process.argv.slice(2);
  const { argv, fromSource, sourceDir } = extractFromSourceFlags(rawArgv);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runtimeOptions = {
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir,
    packageRoot: options.packageRoot,
    sourceDir,
  };

  try {
    if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      writeLine(stdout, buildAgencRuntimeHelp());
      return 0;
    }
    if (fromSource) {
      return await deps.spawnInstalledRuntimeBinFromSource(
        "agenc-runtime",
        argv,
        runtimeOptions,
      );
    }
    return await deps.spawnInstalledRuntimeBin(
      "agenc-runtime",
      argv,
      runtimeOptions,
    );
  } catch (error) {
    writeLine(stderr, formatRuntimeInstallError(error));
    return 1;
  }
}
