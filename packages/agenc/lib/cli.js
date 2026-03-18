import process from "node:process";
import {
  describeRuntimeInstall,
  ensureRuntimeInstalled,
  RuntimeInstallError,
  spawnInstalledRuntimeBin,
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
    "Examples:",
    "  agenc onboard",
    "  agenc start",
    "  agenc status",
    "  agenc logs",
    "  agenc runtime where",
  ].join("\n");
}

function buildAgencRuntimeHelp() {
  return [
    "agenc-runtime [runtime-command] [options]",
    "",
    "Compatibility alias for the installed AgenC runtime CLI.",
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
  describeRuntimeInstall,
  uninstallRuntime,
  spawnInstalledRuntimeBin,
};

function formatRuntimeInstallError(error) {
  if (error instanceof RuntimeInstallError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runAgencWrapper(options = {}, deps = DEFAULT_DEPS) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runtimeOptions = {
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir,
    packageRoot: options.packageRoot,
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
    return await deps.spawnInstalledRuntimeBin("agenc", argv, runtimeOptions);
  } catch (error) {
    writeLine(stderr, formatRuntimeInstallError(error));
    return 1;
  }
}

export async function runAgencRuntimeWrapper(options = {}, deps = DEFAULT_DEPS) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runtimeOptions = {
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir,
    packageRoot: options.packageRoot,
  };

  try {
    if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      writeLine(stdout, buildAgencRuntimeHelp());
      return 0;
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
