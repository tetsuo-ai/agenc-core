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

const DEFAULT_WATCH_XAI_BASE_URL = "https://api.x.ai/v1";

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

export function maskWatchSecret(value) {
  const secret = String(value ?? "").trim();
  if (!secret) {
    return "";
  }
  if (secret.length <= 4) {
    return "*".repeat(secret.length);
  }
  const visibleSuffix = secret.slice(-4);
  const maskedLength = Math.max(4, secret.length - 4);
  return `${"*".repeat(maskedLength)}${visibleSuffix}`;
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

function inspectWatchDaemonState(fs, pidPath, processModule = process) {
  try {
    const pidInfo = readJsonFile(fs, pidPath);
    const daemonPid = Number(pidInfo?.pid);
    const daemonConfigPath =
      typeof pidInfo?.configPath === "string" && pidInfo.configPath.trim()
        ? pidInfo.configPath.trim()
        : null;
    const hasValidPid = Number.isInteger(daemonPid) && daemonPid > 0;
    if (!hasValidPid) {
      return {
        daemonState: daemonConfigPath ? "stale" : "missing",
        daemonPid: null,
        daemonConfigPath,
      };
    }
    try {
      processModule.kill(daemonPid, 0);
      return {
        daemonState: "running",
        daemonPid,
        daemonConfigPath,
      };
    } catch {
      return {
        daemonState: "stale",
        daemonPid,
        daemonConfigPath,
      };
    }
  } catch {
    return {
      daemonState: "missing",
      daemonPid: null,
      daemonConfigPath: null,
    };
  }
}

export function readWatchRuntimeConfig({
  fs,
  env = process.env,
  osModule = os,
  pathModule = path,
  processModule = process,
} = {}) {
  if (!fs || typeof fs.readFileSync !== "function") {
    throw new TypeError("readWatchRuntimeConfig requires an fs object with readFileSync()");
  }
  const paths = resolveWatchRuntimeConfigPaths({ env, osModule, pathModule });
  let resolvedConfigPath = paths.configPath;
  let source = "default";
  const daemonState = inspectWatchDaemonState(fs, paths.pidPath, processModule);
  if (daemonState.daemonState === "running" && daemonState.daemonConfigPath) {
    resolvedConfigPath = daemonState.daemonConfigPath;
    source = "pid";
  }

  try {
    return {
      configPath: resolvedConfigPath,
      source,
      daemonState: daemonState.daemonState,
      daemonPid: daemonState.daemonPid,
      daemonConfigPath: daemonState.daemonConfigPath,
      pidPath: paths.pidPath,
      config: normalizeConfigObject(readJsonFile(fs, resolvedConfigPath)),
      error: null,
    };
  } catch (error) {
    return {
      configPath: resolvedConfigPath,
      source,
      daemonState: daemonState.daemonState,
      daemonPid: daemonState.daemonPid,
      daemonConfigPath: daemonState.daemonConfigPath,
      pidPath: paths.pidPath,
      config: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readWatchXaiConfigStatus(options = {}) {
  const snapshot = readWatchRuntimeConfig(options);
  const llm = normalizeConfigObject(snapshot.config?.llm);
  const apiKey = String(llm.apiKey ?? "").trim();
  return {
    ...snapshot,
    provider: String(llm.provider ?? "").trim() || null,
    model: String(llm.model ?? "").trim() || null,
    baseUrl: String(llm.baseUrl ?? "").trim() || DEFAULT_WATCH_XAI_BASE_URL,
    hasApiKey: apiKey.length > 0,
    maskedApiKey: maskWatchSecret(apiKey),
  };
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
      ...runtimeSkills.map((skill) => {
        const labels = [];
        if (typeof skill?.available === "boolean") {
          labels.push(skill.available ? "available" : "unavailable");
        }
        if (skill?.tier) labels.push(sanitizeText(skill.tier));
        if (skill?.primaryEnv) labels.push(sanitizeText(skill.primaryEnv));
        const pathLabel = skill?.sourcePath ? ` path:${sanitizeText(skill.sourcePath)}` : "";
        const tagsLabel =
          Array.isArray(skill?.tags) && skill.tags.length > 0
            ? ` tags:${skill.tags.map((tag) => sanitizeText(tag)).join(",")}`
            : "";
        const reasonLabel = skill?.unavailableReason
          ? ` reason:${sanitizeText(skill.unavailableReason)}`
          : Array.isArray(skill?.missingRequirements) && skill.missingRequirements.length > 0
            ? ` missing:${skill.missingRequirements.map((entry) => sanitizeText(entry)).join(",")}`
            : "";
        return `  • ${skill.enabled ? "●" : "○"} ${sanitizeText(skill?.name)} — ${sanitizeText(skill?.description)}${
          labels.length > 0 ? ` [${labels.join(", ")}]` : ""
        }${tagsLabel}${pathLabel}${reasonLabel}`;
      }),
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

function formatHooksSection({
  watchState,
  config = {},
} = {}) {
  const configuredHandlers = Array.isArray(config.hooks?.handlers)
    ? config.hooks.handlers
    : [];
  const runtimeHooks = Array.isArray(watchState?.hookCatalog) ? watchState.hookCatalog : [];
  const lines = [
    `- Built-in lifecycle events: ${WATCH_HOOK_EVENTS.length}`,
    `  ${WATCH_HOOK_EVENTS.join(", ")}`,
  ];
  if (runtimeHooks.length > 0) {
    lines.push(`- Runtime hooks: ${runtimeHooks.length}`);
    for (const hook of runtimeHooks) {
      lines.push(
        `  • ${hook.supported === false ? "○" : "●"} ${sanitizeText(hook?.event)} :: ${sanitizeText(hook?.name)} [${sanitizeText(hook?.source, "runtime")}/${sanitizeText(hook?.kind, "custom")}/${sanitizeText(hook?.handlerType, "runtime")}] p=${Number.isFinite(Number(hook?.priority)) ? Number(hook.priority) : 100}${hook?.target ? ` -> ${sanitizeText(hook.target)}` : ""}`,
      );
    }
  } else {
    lines.push("- Runtime hooks: none discovered");
  }
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
      ...formatHooksSection({ watchState, config }),
    ].join("\n");
  }
  const runtimeHookCount = Array.isArray(watchState?.hookCatalog)
    ? watchState.hookCatalog.length
    : 0;
  return [
    ...header,
    "Overview",
    ...formatPluginChannels(watchState.lastStatus ?? {}),
    ...formatTrustedPackages(config),
    ...formatMcpServers(config),
    ...formatSkillsSection({ watchState, localSkillCatalog }),
    `- Hook events: ${WATCH_HOOK_EVENTS.length}`,
    `- Runtime hooks: ${runtimeHookCount}`,
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

export function updateWatchXaiApiKey({
  fs,
  configPath,
  apiKey,
  provider = "grok",
  baseUrl = DEFAULT_WATCH_XAI_BASE_URL,
} = {}) {
  if (!fs || typeof fs.readFileSync !== "function" || typeof fs.writeFileSync !== "function") {
    throw new TypeError("updateWatchXaiApiKey requires fs read/write support");
  }
  const normalizedApiKey = String(apiKey ?? "").trim();
  if (!normalizedApiKey) {
    throw new TypeError("updateWatchXaiApiKey requires a non-empty apiKey");
  }
  const current = loadMutableConfig(fs, configPath);
  const config = {
    ...current,
    llm: normalizeConfigObject(current.llm),
  };
  config.llm.provider = String(provider ?? "grok").trim() || "grok";
  config.llm.apiKey = normalizedApiKey;
  if (!String(config.llm.baseUrl ?? "").trim()) {
    config.llm.baseUrl = String(baseUrl ?? DEFAULT_WATCH_XAI_BASE_URL).trim() || DEFAULT_WATCH_XAI_BASE_URL;
  }
  writeJsonFile(fs, configPath, config);
  return {
    configPath,
    provider: config.llm.provider,
    baseUrl: config.llm.baseUrl,
    model: String(config.llm.model ?? "").trim() || null,
    hasApiKey: true,
    maskedApiKey: maskWatchSecret(normalizedApiKey),
  };
}

export function clearWatchXaiApiKey({
  fs,
  configPath,
} = {}) {
  if (!fs || typeof fs.readFileSync !== "function" || typeof fs.writeFileSync !== "function") {
    throw new TypeError("clearWatchXaiApiKey requires fs read/write support");
  }
  const current = loadMutableConfig(fs, configPath);
  const config = {
    ...current,
    llm: normalizeConfigObject(current.llm),
  };
  const previousApiKey = String(config.llm.apiKey ?? "").trim();
  delete config.llm.apiKey;
  writeJsonFile(fs, configPath, config);
  return {
    configPath,
    provider: String(config.llm.provider ?? "").trim() || null,
    model: String(config.llm.model ?? "").trim() || null,
    baseUrl: String(config.llm.baseUrl ?? "").trim() || DEFAULT_WATCH_XAI_BASE_URL,
    hadApiKey: previousApiKey.length > 0,
    maskedApiKey: maskWatchSecret(previousApiKey),
  };
}
