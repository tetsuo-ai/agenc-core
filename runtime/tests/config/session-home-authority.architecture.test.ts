import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const SOURCE_ROOT = join(import.meta.dirname, "..", "..", "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

function source(name: string): string {
  return readFileSync(join(SOURCE_ROOT, name), "utf8");
}

describe("session home authority architecture", () => {
  test("keeps ambient HomeContext resolution at exact process ingresses", () => {
    const ingress = new Set([
      "bin/agenc-main.ts",
      "bin/mcp-cli.ts",
      "bin/remote-cli.ts",
      "utils/agencInChrome/mcpServer.ts",
      "utils/envUtils.ts",
    ]);
    const directAmbient = /\bresolveHomeContext\(\s*process\.env\s*\)/u;
    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) => {
      const name = relative(SOURCE_ROOT, path).replaceAll("\\", "/");
      if (ingress.has(name)) return [];
      return directAmbient.test(readFileSync(path, "utf8")) ? [name] : [];
    });

    expect(violations).toEqual([]);
  });

  test("forbids ambient secure-storage capture below trusted ingress", () => {
    const directAmbient =
      /\bresolveSecureStorageHome\(\s*process\.env\s*\)/u;
    const callers = sourceFiles(SOURCE_ROOT)
      .filter((path) => directAmbient.test(readFileSync(path, "utf8")))
      .map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"))
      .sort();

    expect(callers).toEqual([]);

    const descriptor = source("utils/authFileDescriptor.ts");
    expect(descriptor).toContain("home: HomeContext");
    expect(descriptor).toContain("environment: DescriptorEnvironment");
    expect(descriptor).toContain("const descriptorCredentialCache = new Map");
    expect(descriptor).not.toContain("process.env");
  });

  test("forbids process-global workspace, temp, stdin, remote, and session-env authority", () => {
    const forbidden =
      /process\.env(?:\.AGENC_(?:WORKSPACE|USE_DATA_STDIN|ENV_FILE|REMOTE|REMOTE_MEMORY_DIR|REMOTE_SESSION_ID)(?![A-Z0-9_])|\[["']TMPDIR["']\])/u;
    const violations = sourceFiles(SOURCE_ROOT)
      .filter((path) => forbidden.test(readFileSync(path, "utf8")))
      .map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"))
      .sort();

    expect(violations).toEqual([]);

    const runtimeOptions = source("session/runtime-options.ts");
    expect(runtimeOptions).toContain('parseBoolean(env, "AGENC_USE_DATA_STDIN", false)');
    expect(runtimeOptions).toContain('parseBoolean(env, "AGENC_REMOTE", false)');
    expect(runtimeOptions).toContain("export function resolveSessionTempRoot");
    expect(runtimeOptions).toContain("getCurrentRuntimeSession()")

    for (const name of [
      "permissions/sandbox.ts",
      "permissions/rpc/request-permissions.ts",
      "sandbox/engine/index.ts",
      "sandbox/engine/manager.ts",
    ]) {
      expect(source(name), name).toContain("resolveSessionTempRoot")
      expect(source(name), name).not.toMatch(/process\.env(?:\.|\[)["']?TMPDIR/u)
    }
  });

  test("keys session environment scripts by explicit home and session identity", () => {
    const sessionEnvironment = source("utils/sessionEnvironment.ts");

    expect(sessionEnvironment).toContain("SessionEnvironmentAuthority")
    expect(sessionEnvironment).toContain("authority.homePath")
    expect(sessionEnvironment).toContain("authority.sessionId")
    expect(sessionEnvironment).toContain("sessionEnvironmentScripts = new Map")
    expect(sessionEnvironment).toContain("requireCurrentRuntimeSession")
    expect(sessionEnvironment).toContain("disposeSessionEnvironment")
    expect(sessionEnvironment).not.toContain("process.env")
    expect(sessionEnvironment).not.toContain("getSessionId")
    expect(sessionEnvironment).not.toContain("getAgenCHomeDir")
    expect(source("session/session.ts")).toContain("disposeSessionEnvironment")
  });

  test("keeps remote behavior typed while attribution metadata stays session-captured", () => {
    const environment = source("session/environment.ts");
    const runtimeOptions = source("session/runtime-options.ts");
    const attribution = source("utils/attribution.ts");
    const apiClient = source("services/api/client.ts");

    expect(environment).not.toMatch(/["']AGENC_REMOTE["']/u);
    expect(environment).toContain('"AGENC_REMOTE_SESSION_ID"');
    expect(environment).toContain('"SESSION_INGRESS_URL"');
    expect(runtimeOptions).toContain('parseBoolean(env, "AGENC_REMOTE", false)');
    expect(attribution).toContain("isSessionRemoteMode()")
    expect(attribution).toContain("environment.AGENC_REMOTE_SESSION_ID")
    expect(attribution).toContain("environment.SESSION_INGRESS_URL")
    expect(apiClient).toContain("providerEnvironment.AGENC_REMOTE_SESSION_ID")

    for (const name of [
      "context.ts",
      "services/api/errors.ts",
      "services/api/anthropic.ts",
      "services/api/withRetry.ts",
      "memory/session/sessionMemoryUtils.ts",
      "services/extractMemories/memory-paths.ts",
      "services/voice.ts",
      "utils/auth.ts",
    ]) {
      expect(source(name), name).not.toMatch(/\.AGENC_REMOTE\b/u)
    }
  });

  test("builds teammate environment from session-owned provider and home authority", () => {
    const spawnUtils = source("utils/swarm/spawnUtils.ts");

    expect(spawnUtils).toContain("getSelectedProviderSelection()")
    expect(spawnUtils).toContain("getAgenCHomeDir()")
    expect(spawnUtils).toContain("const value = environment[key]")
    expect(spawnUtils).not.toContain("const value = process.env[key]")
  });

  test("does not retain dead process-global activity or subprocess proxy registries", () => {
    expect(() => source("utils/sessionActivity.ts")).toThrow();
    const subprocessEnvironment = source("utils/subprocessEnv.ts");
    expect(subprocessEnvironment).not.toContain("registerUpstreamProxyEnvFn")
    expect(subprocessEnvironment).not.toContain("_getUpstreamProxyEnv")
    expect(subprocessEnvironment).not.toContain("env.AGENC_SUBPROCESS_ENV_SCRUB")
  });

  test("binds central home helpers to the current session without memoization", () => {
    const envUtils = source("utils/envUtils.ts");
    const sessionStore = source("session/session-store.ts");
    const planFiles = source("planning/plan-files.ts");
    const memoryPaths = source("memory/session/sessionMemoryUtils.ts");
    const instructions = source("prompts/agenc-md.ts");
    const resumeSession = source("bin/resume-session.ts");

    expect(envUtils).toContain("getCurrentRuntimeSession()")
    expect(envUtils).toContain("store?.homeContext")
    expect(envUtils).toContain("getCanonicalSettingsAuthority()")
    expect(envUtils).not.toMatch(/memoize[\s\S]{0,200}getAgenCHomeDir/u)

    const sessionHomeHelper = sessionStore.match(
      /export function getAgencHomeDir\([\s\S]*?\n\}/u,
    )?.[0] ?? "";
    expect(sessionHomeHelper).toContain("getAgenCHomeDir()")
    expect(sessionHomeHelper).not.toContain("process.env")

    const planHomeHelper = planFiles.match(
      /function resolveAgencHome\([\s\S]*?\n\}/u,
    )?.[0] ?? "";
    expect(planHomeHelper).toContain("getAgenCHomeDir()")
    expect(planHomeHelper).not.toContain("process.env")

    expect(memoryPaths).toContain(": getAgenCHomeDir())")
    expect(memoryPaths).not.toContain("options.env ?? process.env")
    expect(instructions).toContain("return getAgenCHomeDir();")
    expect(instructions).not.toContain("opts.configHomeDir === undefined ? {}")
    expect(resumeSession).not.toContain("getAgencHomeDir()")
    expect(resumeSession).toContain("agencHome: string")
  });

  test("namespaces process-global home-derived caches by canonical home", () => {
    const expectedHomeKeys = [
      ["utils/markdownConfigLoader.ts", "${getAgenCHomeDir()}\\u0000${subdir}"],
      ["skills/loadSkillsDir.ts", "${resolve(cwd)}\\u0000${getAgenCHomeDir()}"],
      ["tools/AgentTool/loadAgentsDir.ts", "${getAgenCHomeDir()}\\u0000${resolve(cwd)}"],
      ["utils/sessionStorage.ts", "${getAgenCHomeDir()}\\u0000${projectDir}"],
      ["utils/plans.ts", "${getAgenCHomeDir()}\\u0000${getCwd()}"],
      ["memory/paths.ts", "${getAgenCHomeDir()}\\u0000${getSessionRemoteMemoryRoot()"],
    ] as const;

    for (const [name, key] of expectedHomeKeys) {
      expect(source(name), name).toContain(key);
    }

    const mcpClient = source("services/mcp/client.ts");
    expect(mcpClient).toContain(
      "const authCachePromises = new Map<string, Promise<McpAuthCacheData>>()",
    );
    expect(mcpClient).toContain("function getMcpAuthCache(home: HomeContext)");
    expect(mcpClient).toContain("getMcpAuthCachePath(home)");
    expect(mcpClient).not.toContain("getAgenCHomeDir");
  });

  test("passes canonical home into every production rollout writer", () => {
    const productionWriters = [
      "bin/bootstrap.ts",
      "session/child-run-journal.ts",
      "utils/swarm/inProcessRunner.ts",
    ];
    const missing = productionWriters.flatMap((name) => {
      const content = source(name);
      return [...content.matchAll(/new RolloutStore\(\{/gu)].flatMap(
        (match, index) => {
          const start = match.index ?? 0;
          const construction = content.slice(start, start + 500);
          return /\bagencHome\b/u.test(construction)
            ? []
            : [`${name}#${index + 1}`];
        },
      );
    });

    expect(missing).toEqual([]);
    expect(source("eval-executor/trust-run.ts")).not.toMatch(
      /process\.env\.AGENC_HOME\s*=/u,
    );
  });

  test("centralizes the signed session/home plan-file boundary", () => {
    const filesystem = source("tools/system/filesystem.ts");
    const codingCommon = source("tools/system/coding-common.ts");
    const worktree = source("tools/system/worktree.ts");

    expect(filesystem).toContain("verifiedPlanFileContextFromArgs")
    expect(filesystem).toContain("SESSION_AGENC_HOME_ARG")
    for (const consumer of [codingCommon, worktree]) {
      expect(consumer).toContain("verifiedPlanFileContextFromArgs")
      expect(consumer).not.toContain("resolveHomeContext(process.env)")
    }
  });

  test("derives trust and tool workspace identity from the active session", () => {
    const filesystem = source("tools/system/filesystem.ts");
    const trust = source("permissions/trust/project-trust.ts");

    expect(filesystem).toContain("getCurrentRuntimeSession()?.sessionConfiguration.cwd")
    expect(trust).toContain("getCurrentRuntimeSession()?.sessionConfiguration.cwd")
    expect(`${filesystem}\n${trust}`).not.toContain("process.env.AGENC_WORKSPACE")
  });

  test("keeps slash auth on captured config, provider, and home authority", () => {
    const auth = source("commands/auth.tsx");

    expect(auth).not.toContain("process.env")
    expect(auth).toContain("requireCommandConfigStore(ctx)")
    expect(auth).toContain("providerEnvironmentFromCommandContext(ctx)")
    expect(auth).toContain("configStore.homeContext.path")
  });
});
