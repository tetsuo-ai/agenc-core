import os from "node:os";
import path from "node:path";

const WATCH_HOOK_EVENTS = Object.freeze([
  "gateway:startup",
  "gateway:shutdown",
  "agent:bootstrap",
  "session:start",
  "session:end",
  "session:compact",
  "message:inbound",
  "message:outbound",
  "tool:before",
  "tool:after",
  "heartbeat:before",
  "heartbeat:after",
  "command:new",
  "command:reset",
  "command:stop",
  "config:reload",
]);

function sanitizeText(value, fallback = "n/a") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function normalizeConfigObject(config) {
  return config && typeof config === "object" && !Array.isArray(config) ? config : {};
}

function stableSortStrings(values = []) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function resolveWatchRuntimeConfigPaths({
  env = process.env,
  osModule = os,
  pathModule = path,
} = {}) {
  const homeDir = osModule.homedir();
  const pidPath = env.AGENC_PID_PATH ?? pathModule.join(homeDir, ".agenc", "daemon.pid");
  const configPath = env.AGENC_CONFIG_PATH ?? pathModule.join(homeDir, ".agenc", "config.json");
  return {
    pidPath,
    configPath,
    userSkillsPath: pathModule.join(homeDir, ".agenc", "skills"),
  };
}

function readJsonFile(fs, filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

export function readWatchRuntimeConfig({
  fs,
  env = process.env,
  osModule = os,
  pathModule = path,
} = {}) {
  if (!fs || typeof fs.readFileSync !== "function") {
    throw new TypeError("readWatchRuntimeConfig requires an fs object with readFileSync()");
  }
  const paths = resolveWatchRuntimeConfigPaths({ env, osModule, pathModule });
  let resolvedConfigPath = paths.configPath;
  let source = "default";
  try {
    const pidInfo = readJsonFile(fs, paths.pidPath);
    if (typeof pidInfo?.configPath === "string" && pidInfo.configPath.trim()) {
      resolvedConfigPath = pidInfo.configPath.trim();
      source = "pid";
    }
  } catch {}

  try {
    return {
      configPath: resolvedConfigPath,
      source,
      config: normalizeConfigObject(readJsonFile(fs, resolvedConfigPath)),
      error: null,
    };
  } catch (error) {
    return {
      configPath: resolvedConfigPath,
      source,
      config: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function listWatchUserSkills({
  fs,
  env = process.env,
  osModule = os,
  pathModule = path,
} = {}) {
  if (!fs || typeof fs.readdirSync !== "function") {
    throw new TypeError("listWatchUserSkills requires an fs object with readdirSync()");
  }
  const { userSkillsPath } = resolveWatchRuntimeConfigPaths({
    env,
    osModule,
    pathModule,
  });
  try {
    return {
      userSkillsPath,
      skills: stableSortStrings(
        fs.readdirSync(userSkillsPath, { withFileTypes: true })
          .filter((entry) => entry?.isFile?.() && /\.md$/i.test(entry.name))
          .map((entry) => entry.name.replace(/\.md$/i, "")),
      ),
      error: null,
    };
  } catch (error) {
    return {
      userSkillsPath,
      skills: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatTrustedPackages(config = {}) {
  const trustedPackages = Array.isArray(config.plugins?.trustedPackages)
    ? config.plugins.trustedPackages
    : [];
  if (trustedPackages.length === 0) {
    return ["- Trusted packages: none"];
  }
  return [
    `- Trusted packages: ${trustedPackages.length}`,
    ...trustedPackages.map((entry) => {
      const packageName = sanitizeText(entry?.packageName);
      const subpaths = Array.isArray(entry?.allowedSubpaths) && entry.allowedSubpaths.length > 0
        ? ` (${entry.allowedSubpaths.join(", ")})`
        : "";
      return `  • ${packageName}${subpaths}`;
    }),
  ];
}

function formatMcpServers(config = {}) {
  const servers = Array.isArray(config.mcp?.servers) ? config.mcp.servers : [];
  if (servers.length === 0) {
    return ["- MCP servers: none"];
  }
  return [
    `- MCP servers: ${servers.length}`,
    ...servers.map((server) => {
      const enabled = server?.enabled === false ? "disabled" : "enabled";
      const trust = server?.trustTier ? `, ${server.trustTier}` : "";
      const container = server?.container ? `, container:${server.container}` : "";
      return `  • ${sanitizeText(server?.name)} — ${sanitizeText(server?.command)} ${Array.isArray(server?.args) ? server.args.join(" ") : ""} [${enabled}${trust}${container}]`.trim();
    }),
  ];
}

function formatPluginChannels(status = {}) {
  const channelStatuses = Array.isArray(status?.channelStatuses) ? status.channelStatuses : [];
  if (channelStatuses.length === 0) {
    return ["- Channel plugins: none reported"];
  }
  return [
    `- Channel plugins: ${channelStatuses.length}`,
    ...channelStatuses.map((entry) => {
      const mode = entry?.mode ? `/${entry.mode}` : "";
      const health = entry?.active
        ? sanitizeText(entry?.health, "active")
        : entry?.enabled
          ? "configured"
          : "disabled";
      return `  • ${sanitizeText(entry?.name)} — ${health}${mode}`;
    }),
  ];
}

function formatSkillsSection({
  watchState,
  localSkillCatalog,
}) {
  const runtimeSkills = Array.isArray(watchState?.skillCatalog) ? watchState.skillCatalog : [];
  if (runtimeSkills.length > 0) {
    return [
      `- Runtime skills: ${runtimeSkills.length}`,
      ...runtimeSkills.map((skill) =>
        `  • ${skill.enabled ? "●" : "○"} ${sanitizeText(skill?.name)} — ${sanitizeText(skill?.description)}`,
      ),
    ];
  }
  if (localSkillCatalog.skills.length > 0) {
    return [
      `- User skills on disk: ${localSkillCatalog.skills.length}`,
      ...localSkillCatalog.skills.map((skill) => `  • ${skill}`),
    ];
  }
  return ["- Skills: none discovered"];
}

function formatHooksSection(config = {}) {
  const configuredHandlers = Array.isArray(config.hooks?.handlers)
    ? config.hooks.handlers
    : [];
  const lines = [
    `- Built-in lifecycle events: ${WATCH_HOOK_EVENTS.length}`,
    `  ${WATCH_HOOK_EVENTS.join(", ")}`,
  ];
  if (configuredHandlers.length > 0) {
    lines.push(`- Configured hook handlers: ${configuredHandlers.length}`);
    for (const handler of configuredHandlers) {
      lines.push(
        `  • ${sanitizeText(handler?.name)} — ${sanitizeText(handler?.event)} [${handler?.enabled === false ? "disabled" : "enabled"}]`,
      );
    }
  } else {
    lines.push("- Configured hook handlers: none");
  }
  return lines;
}

export function buildWatchExtensibilityReport({
  projectRoot = process.cwd(),
  watchState,
  configSnapshot = { configPath: "n/a", source: "default", config: {}, error: null },
  localSkillCatalog = { userSkillsPath: "n/a", skills: [], error: null },
  section = "overview",
} = {}) {
  if (!watchState || typeof watchState !== "object") {
    throw new TypeError("buildWatchExtensibilityReport requires a watchState object");
  }
  const config = normalizeConfigObject(configSnapshot.config);
  const normalizedSection = String(section ?? "overview").trim().toLowerCase();
  const header = [
    "Watch Extensibility",
    `Workspace: ${sanitizeText(projectRoot, process.cwd())}`,
    `Config: ${sanitizeText(configSnapshot.configPath)}`,
    `Config source: ${sanitizeText(configSnapshot.source, "default")}`,
  ];
  if (configSnapshot.error) {
    header.push(`Config load: ${sanitizeText(configSnapshot.error)}`);
  }
  header.push("");

  if (normalizedSection === "skills") {
    return [
      ...header,
      "Skills",
      ...formatSkillsSection({ watchState, localSkillCatalog }),
      `- User skill path: ${sanitizeText(localSkillCatalog.userSkillsPath)}`,
      ...(localSkillCatalog.error ? [`- User skill scan: ${sanitizeText(localSkillCatalog.error)}`] : []),
    ].join("\n");
  }
  if (normalizedSection === "plugins") {
    return [
      ...header,
      "Plugins",
      ...formatPluginChannels(watchState.lastStatus ?? {}),
      ...formatTrustedPackages(config),
    ].join("\n");
  }
  if (normalizedSection === "mcp") {
    return [
      ...header,
      "MCP",
      ...formatMcpServers(config),
    ].join("\n");
  }
  if (normalizedSection === "hooks") {
    return [
      ...header,
      "Hooks",
      ...formatHooksSection(config),
    ].join("\n");
  }
  return [
    ...header,
    "Overview",
    ...formatPluginChannels(watchState.lastStatus ?? {}),
    ...formatTrustedPackages(config),
    ...formatMcpServers(config),
    ...formatSkillsSection({ watchState, localSkillCatalog }),
    `- Hook events: ${WATCH_HOOK_EVENTS.length}`,
    `- User skill path: ${sanitizeText(localSkillCatalog.userSkillsPath)}`,
    ...(localSkillCatalog.error ? [`- User skill scan: ${sanitizeText(localSkillCatalog.error)}`] : []),
  ].join("\n");
}

function writeJsonFile(fs, filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serialized);
}

function loadMutableConfig(fs, configPath) {
  try {
    return normalizeConfigObject(readJsonFile(fs, configPath));
  } catch {
    return {};
  }
}

export function updateWatchTrustedPluginPackage({
  fs,
  configPath,
  packageName,
  allowedSubpaths = [],
  remove = false,
} = {}) {
  if (!fs || typeof fs.readFileSync !== "function" || typeof fs.writeFileSync !== "function") {
    throw new TypeError("updateWatchTrustedPluginPackage requires fs read/write support");
  }
  const normalizedPackageName = String(packageName ?? "").trim();
  if (!normalizedPackageName) {
    throw new TypeError("updateWatchTrustedPluginPackage requires a packageName");
  }
  const current = loadMutableConfig(fs, configPath);
  const config = {
    ...current,
    plugins: normalizeConfigObject(current.plugins),
  };
  const trustedPackages = Array.isArray(config.plugins.trustedPackages)
    ? [...config.plugins.trustedPackages]
    : [];
  const nextTrustedPackages = trustedPackages.filter(
    (entry) => String(entry?.packageName ?? "").trim() !== normalizedPackageName,
  );
  if (!remove) {
    nextTrustedPackages.push({
      packageName: normalizedPackageName,
      ...(Array.isArray(allowedSubpaths) && allowedSubpaths.length > 0
        ? { allowedSubpaths: stableSortStrings(
            allowedSubpaths
              .map((entry) => String(entry ?? "").trim())
              .filter(Boolean),
          ) }
        : {}),
    });
    nextTrustedPackages.sort((left, right) =>
      String(left?.packageName ?? "").localeCompare(String(right?.packageName ?? "")),
    );
  }
  config.plugins.trustedPackages = nextTrustedPackages;
  writeJsonFile(fs, configPath, config);
  return {
    configPath,
    packageName: normalizedPackageName,
    trustedPackages: nextTrustedPackages,
    removed: remove,
  };
}

export function updateWatchMcpServerState({
  fs,
  configPath,
  serverName,
  enabled,
} = {}) {
  if (!fs || typeof fs.readFileSync !== "function" || typeof fs.writeFileSync !== "function") {
    throw new TypeError("updateWatchMcpServerState requires fs read/write support");
  }
  const normalizedServerName = String(serverName ?? "").trim();
  if (!normalizedServerName) {
    throw new TypeError("updateWatchMcpServerState requires a serverName");
  }
  if (typeof enabled !== "boolean") {
    throw new TypeError("updateWatchMcpServerState requires an enabled boolean");
  }
  const current = loadMutableConfig(fs, configPath);
  const config = {
    ...current,
    mcp: normalizeConfigObject(current.mcp),
  };
  const servers = Array.isArray(config.mcp.servers) ? [...config.mcp.servers] : [];
  const index = servers.findIndex(
    (entry) => String(entry?.name ?? "").trim() === normalizedServerName,
  );
  if (index === -1) {
    throw new Error(`No MCP server named ${normalizedServerName} was found in ${configPath}`);
  }
  servers[index] = {
    ...servers[index],
    enabled,
  };
  config.mcp.servers = servers;
  writeJsonFile(fs, configPath, config);
  return {
    configPath,
    serverName: normalizedServerName,
    enabled,
    servers,
  };
}
