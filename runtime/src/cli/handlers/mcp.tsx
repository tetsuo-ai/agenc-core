/**
 * MCP subcommand handlers — extracted from main.tsx for lazy loading.
 * These are dynamically imported only when the corresponding `agenc mcp *` command runs.
 */

import pMap from 'p-map';
import { MCPServerDesktopImportDialog } from '../../tui/components/MCPServerDesktopImportDialog.js';
import { render } from '../../tui/ink.js';
import { KeybindingSetup } from '../../tui/keybindings/KeybindingProviderSetup.js';
import {
  clearMcpClientConfig,
  clearServerTokensFromSecureStorage,
  readClientSecret,
  saveMcpClientSecret,
} from '../../services/mcp/auth.js'
import { doctorAllServers, doctorServer, type McpDoctorReport, type McpDoctorScopeFilter } from '../../services/mcp/doctor.js';
import { connectToServer, getMcpServerConnectionBatchSize } from '../../services/mcp/client.js';
import { addMcpConfig, getAllMcpConfigs, getMcpConfigByName, getMcpConfigsByScope, removeMcpConfig } from '../../services/mcp/config.js';
import { redactMcpDisplayValue } from '../../services/mcp/redaction.js';
import { normalizeNameForMCP } from '../../services/mcp/normalization.js';
import type { ConfigScope, ScopedMcpServerConfig } from '../../services/mcp/types.js';
import { describeMcpConfigFilePath, ensureConfigScope, getScopeLabel, projectMcpServerApprovalDigest } from '../../services/mcp/utils.js';
import { AppStateProvider } from '../../tui/state/AppState.js';
import { getCurrentProjectConfig, saveCurrentProjectConfig } from '../../utils/config.js';
import { gracefulShutdown } from '../../utils/gracefulShutdown.js';
import { safeParseJSON } from '../../utils/json.js';
import { cliError, cliOk } from '../exit.js';

function formatDoctorReport(report: McpDoctorReport): string {
  const lines: string[] = []
  lines.push('MCP Doctor')
  lines.push('')
  lines.push('Summary')
  lines.push(`- ${report.summary.totalReports} server reports generated`)
  lines.push(`- ${report.summary.healthy} healthy`)
  lines.push(`- ${report.summary.warnings} warnings`)
  lines.push(`- ${report.summary.blocking} blocking issues`)

  if (report.targetName) {
    lines.push(`- target: ${report.targetName}`)
  }

  for (const server of report.servers) {
    lines.push('')
    lines.push(server.serverName)

    const activeDefinition = server.definitions.find(definition => definition.runtimeActive)
    if (activeDefinition) {
      lines.push(`- Active source: ${activeDefinition.sourceType}`)
      lines.push(`- Transport: ${activeDefinition.transport ?? 'unknown'}`)
    }

    if (server.definitions.length > 1) {
      const extraDefinitions = server.definitions
        .filter(definition => !definition.runtimeActive)
        .map(definition => definition.sourceType)
      if (extraDefinitions.length > 0) {
        lines.push(`- Additional definitions: ${extraDefinitions.join(', ')}`)
      }
    }

    if (server.liveCheck.result) {
      const stateLikeResults = new Set(['disabled', 'pending', 'skipped'])
      const label = stateLikeResults.has(server.liveCheck.result)
        ? 'State'
        : 'Live check'
      lines.push(`- ${label}: ${server.liveCheck.result}`)
    }

    if (server.liveCheck.error) {
      lines.push(`- Error: ${server.liveCheck.error}`)
    }

    for (const finding of server.findings) {
      lines.push(`- ${finding.message}`)
      if (finding.remediation) {
        lines.push(`- Fix: ${finding.remediation}`)
      }
    }
  }

  if (report.findings.length > 0) {
    lines.push('')
    lines.push('Global findings')
    for (const finding of report.findings) {
      lines.push(`- ${finding.message}`)
      if (finding.remediation) {
        lines.push(`- Fix: ${finding.remediation}`)
      }
    }
  }

  return lines.join('\n')
}

export async function mcpDoctorHandler(name: string | undefined, options: {
  scope?: string;
  configOnly?: boolean;
  json?: boolean;
}): Promise<void> {
  try {
    const scopeFilter = options.scope ? ensureConfigScope(options.scope) as McpDoctorScopeFilter : undefined
    const configOnly = !!options.configOnly
    const report = name
      ? await doctorServer(name, { configOnly, scopeFilter })
      : await doctorAllServers({ configOnly, scopeFilter })

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      process.stdout.write(`${formatDoctorReport(report)}\n`)
    }

    // On Windows, exiting immediately after a single failed HTTP MCP health check
    // can trip a libuv assertion while async handle shutdown is still settling.
    // Let the event loop drain briefly before exiting this one-shot command.
    await new Promise(resolve => setTimeout(resolve, 50))
    process.exit(report.summary.blocking > 0 ? 1 : 0)
    return
  } catch (error) {
    cliError((error as Error).message)
  }
}
async function checkMcpServerHealth(name: string, server: ScopedMcpServerConfig): Promise<string> {
  try {
    const result = await connectToServer(name, server);
    if (result.type === 'connected') {
      return '✓ Connected';
    } else if (result.type === 'needs-auth') {
      return '! Needs authentication';
    } else {
      return '✗ Failed to connect';
    }
  } catch (_error) {
    return '✗ Connection error';
  }
}

// mcp remove (lines 4545–4635)
export async function mcpRemoveHandler(name: string, options: {
  scope?: string;
}): Promise<void> {
  // Look up config before removing so we can clean up secure storage
  const serverBeforeRemoval = getMcpConfigByName(name);
  const cleanupSecureStorage = () => {
    if (serverBeforeRemoval && (serverBeforeRemoval.type === 'sse' || serverBeforeRemoval.type === 'http')) {
      clearServerTokensFromSecureStorage(name, serverBeforeRemoval);
      clearMcpClientConfig(name, serverBeforeRemoval);
    }
  };
  try {
    if (options.scope) {
      const scope = ensureConfigScope(options.scope);
      await removeMcpConfig(name, scope);
      cleanupSecureStorage();
      process.stdout.write(`Removed MCP server ${name} from ${scope} config\n`);
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`);
    }

    // If no scope specified, check where the server exists
    const projectConfig = getCurrentProjectConfig();
    // Check if server exists in project scope (.mcp.json)
    const {
      servers: projectServers
    } = getMcpConfigsByScope('project');
    const {
      servers: userServers
    } = getMcpConfigsByScope('user');
    const mcpJsonExists = !!projectServers[name];

    // Count how many scopes contain this server
    const scopes: Array<Exclude<ConfigScope, 'dynamic'>> = [];
    if (projectConfig.mcpServers?.[name]) scopes.push('local');
    if (mcpJsonExists) scopes.push('project');
    if (userServers[name]) scopes.push('user');
    if (scopes.length === 0) {
      cliError(`No MCP server found with name: "${name}"`);
    } else if (scopes.length === 1) {
      // Server exists in only one scope, remove it
      const scope = scopes[0]!;
      await removeMcpConfig(name, scope);
      cleanupSecureStorage();
      process.stdout.write(`Removed MCP server "${name}" from ${scope} config\n`);
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`);
    } else {
      // Server exists in multiple scopes
      process.stderr.write(`MCP server "${name}" exists in multiple scopes:\n`);
      scopes.forEach(scope => {
        process.stderr.write(`  - ${getScopeLabel(scope)} (${describeMcpConfigFilePath(scope)})\n`);
      });
      process.stderr.write('\nTo remove from a specific scope, use:\n');
      scopes.forEach(scope => {
        process.stderr.write(`  agenc mcp remove "${name}" -s ${scope}\n`);
      });
      cliError();
    }
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp list (lines 4641–4688)
export async function mcpListHandler(): Promise<void> {
  const {
    servers: configs
  } = await getAllMcpConfigs();
  if (Object.keys(configs).length === 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('No MCP servers configured. Use `agenc mcp add` to add a server.');
  } else {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Checking MCP server health...\n');

    // Check servers concurrently
    const entries = Object.entries(configs);
    const results = await pMap(entries, async ([name, server]) => ({
      name,
      server,
      status: await checkMcpServerHealth(name, server)
    }), {
      concurrency: getMcpServerConnectionBatchSize()
    });
    for (const {
      name,
      server,
      status
    } of results) {
      // Intentionally excluding sse-ide servers here since they're internal
      if (server.type === 'sse') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} (SSE) - ${status}`);
      } else if (server.type === 'http') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} (HTTP) - ${status}`);
      } else if (server.type === 'agencai-proxy') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} - ${status}`);
      } else if (!server.type || server.type === 'stdio') {
        const args = Array.isArray(server.args) ? server.args : [];
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.command} ${args.join(' ')} - ${status}`);
      }
    }
  }
  // Use gracefulShutdown to properly clean up MCP server connections
  // (process.exit bypasses cleanup handlers, leaving child processes orphaned)
  await gracefulShutdown(0);
}

// mcp get (lines 4694–4786)
export async function mcpGetHandler(name: string): Promise<void> {
  const server = getMcpConfigByName(name);
  if (!server) {
    cliError(`No MCP server found with name: ${name}`);
  }

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`${name}:`);
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`  Scope: ${getScopeLabel(server.scope)}`);

  // Check server health
  const status = await checkMcpServerHealth(name, server);
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`  Status: ${status}`);

  // Intentionally excluding sse-ide servers here since they're internal
  if (server.type === 'sse') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: sse`);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  URL: ${server.url}`);
    if (server.headers) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Headers:');
      for (const [key, value] of Object.entries(server.headers)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}: ${redactMcpDisplayValue(key, value)}`);
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = [];
      if (server.oauth.clientId) {
        parts.push('oauth client configured');
      }
      if (server.oauth.callbackPort) parts.push('callback port configured');
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  OAuth: ${parts.join(', ')}`);
    }
  } else if (server.type === 'http') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: http`);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  URL: ${server.url}`);
    if (server.headers) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Headers:');
      for (const [key, value] of Object.entries(server.headers)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}: ${redactMcpDisplayValue(key, value)}`);
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = [];
      if (server.oauth.clientId) {
        parts.push('oauth client configured');
      }
      if (server.oauth.callbackPort) parts.push('callback port configured');
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  OAuth: ${parts.join(', ')}`);
    }
  } else if (server.type === 'stdio') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: stdio`);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Command: ${server.command}`);
    const args = Array.isArray(server.args) ? server.args : [];
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Args: ${args.join(' ')}`);
    if (server.env) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Environment:');
      for (const [key, value] of Object.entries(server.env)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}=${redactMcpDisplayValue(key, value)}`);
      }
    }
  }
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`\nTo remove this server, run: agenc mcp remove "${name}" -s ${server.scope}`);
  // Use gracefulShutdown to properly clean up MCP server connections
  // (process.exit bypasses cleanup handlers, leaving child processes orphaned)
  await gracefulShutdown(0);
}

// mcp add-json (lines 4801–4870)
export async function mcpAddJsonHandler(name: string, json: string, options: {
  scope?: string;
  clientSecret?: true;
}): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope ?? 'user');
    const parsedJson = safeParseJSON(json);

    // Read secret before writing config so cancellation doesn't leave partial state
    const needsSecret = options.clientSecret && parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson && (parsedJson.type === 'sse' || parsedJson.type === 'http') && 'url' in parsedJson && typeof parsedJson.url === 'string' && 'oauth' in parsedJson && parsedJson.oauth && typeof parsedJson.oauth === 'object' && 'clientId' in parsedJson.oauth;
    const clientSecret = needsSecret ? await readClientSecret() : undefined;
    await addMcpConfig(name, parsedJson, scope);
    const transportType = parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson ? String(parsedJson.type || 'stdio') : 'stdio';
    if (clientSecret && parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson && (parsedJson.type === 'sse' || parsedJson.type === 'http') && 'url' in parsedJson && typeof parsedJson.url === 'string') {
      saveMcpClientSecret(name, {
        type: parsedJson.type,
        url: parsedJson.url
      }, clientSecret);
    }
    cliOk(`Added ${transportType} MCP server ${name} to ${scope} config`);
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp add-from-agenc-desktop (lines 4881–4927)
export async function mcpAddFromDesktopHandler(options: {
  scope?: string;
}): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope);
    const {
      readAgenCDesktopMcpServers
    } = await import('../../utils/agencDesktop.js');
    const servers = await readAgenCDesktopMcpServers();
    if (Object.keys(servers).length === 0) {
      cliOk('No MCP servers found in AgenC Desktop configuration or configuration file does not exist.');
    }
    const {
      unmount
    } = await render(<AppStateProvider>
        <KeybindingSetup>
          <MCPServerDesktopImportDialog servers={servers} scope={scope} onDone={() => {
          unmount();
        }} />
        </KeybindingSetup>
      </AppStateProvider>, {
      exitOnCtrlC: true
    });
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp reset-project-choices (lines 4935–4952)
export async function mcpApproveProjectHandler(name: string): Promise<void> {
  try {
    const { servers, errors } = getMcpConfigsByScope('project')
    const normalizedName = normalizeNameForMCP(name)
    const match = Object.entries(servers).find(
      ([candidate]) => normalizeNameForMCP(candidate) === normalizedName,
    )
    if (!match) {
      const detail = errors.length > 0 ? ` (${errors[0]!.message})` : ''
      throw new Error(`No project-scoped MCP server found with name: ${name}${detail}`)
    }
    const [serverName, config] = match
    const digest = projectMcpServerApprovalDigest(config)
    saveCurrentProjectConfig(current => ({
      ...current,
      approvedMcpjsonServerDigests: {
        ...current.approvedMcpjsonServerDigests,
        [normalizeNameForMCP(serverName)]: digest,
      },
      disabledMcpjsonServers: (current.disabledMcpjsonServers ?? []).filter(
        candidate => normalizeNameForMCP(candidate) !== normalizedName,
      ),
    }))
    cliOk(
      `Approved the current definition of project MCP server ${serverName}. Changes to .mcp.json require approval again.`,
    )
  } catch (error) {
    cliError((error as Error).message)
  }
}

export async function mcpResetChoicesHandler(): Promise<void> {
  saveCurrentProjectConfig(current => ({
    ...current,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    enableAllProjectMcpServers: false,
    approvedMcpjsonServerDigests: {},
  }));
  cliOk('All project-scoped (.mcp.json) server approvals and rejections have been reset.\n' + 'You will be prompted for approval next time you start AgenC.');
}
