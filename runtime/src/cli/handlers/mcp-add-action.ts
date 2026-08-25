import type { Writable } from "node:stream";
import type { ProviderEnvironment } from "../../llm/provider-options.js";
import type { CanonicalSettingsAuthority } from "../../utils/settings/canonicalAuthority.js";

import {
  readClientSecret,
  saveMcpClientSecret,
} from "../../services/mcp/auth.js";
import { addMcpConfig } from "../../services/mcp/config.js";
import {
  describeMcpConfigFilePath,
  ensureConfigScope,
  ensureTransport,
  parseHeaders,
} from "../../services/mcp/utils.js";
import {
  getXaaIdpConfig,
  isXaaEnabled,
} from "../../services/mcp/xaaIdpLogin.js";
import { redactMcpDisplayValue } from "../../services/mcp/redaction.js";
import { parseEnvVars } from "../../utils/envUtils.js";

export interface McpAddActionOptions {
  readonly authority: CanonicalSettingsAuthority;
  readonly environment: ProviderEnvironment;
  readonly scope?: string;
  readonly transport?: string;
  readonly env?: string[];
  readonly header?: string[];
  readonly clientId?: string;
  readonly clientSecret?: boolean;
  readonly xaa?: boolean;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export async function runMcpAddAction(
  name: string,
  commandOrUrl: string,
  args: readonly string[],
  options: McpAddActionOptions,
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const scope = ensureConfigScope(options.scope ?? "user");
  const transport = ensureTransport(options.transport);

  if (options.xaa && !isXaaEnabled(options.environment)) {
    throw new Error("Error: --xaa requires AGENC_ENABLE_XAA=1 in your environment");
  }
  const xaa = Boolean(options.xaa);
  if (xaa) {
    const missing: string[] = [];
    if (!options.clientId) missing.push("--client-id");
    if (!options.clientSecret) missing.push("--client-secret");
    if (!getXaaIdpConfig()) {
      missing.push("'agenc mcp xaa setup' (xaa_idp is not configured)");
    }
    if (missing.length > 0) {
      throw new Error(`Error: --xaa requires: ${missing.join(", ")}`);
    }
  }

  const transportExplicit = options.transport !== undefined;
  const looksLikeUrl =
    commandOrUrl.startsWith("http://") ||
    commandOrUrl.startsWith("https://") ||
    commandOrUrl.startsWith("localhost") ||
    commandOrUrl.endsWith("/sse") ||
    commandOrUrl.endsWith("/mcp");

  if (transport === "sse" || transport === "http") {
    const headers = options.header ? parseHeaders(options.header) : undefined;
    const oauth =
      options.clientId || xaa
        ? {
            ...(options.clientId ? { clientId: options.clientId } : {}),
            ...(xaa ? { xaa: true } : {}),
          }
        : undefined;
    const clientSecret =
      options.clientSecret && options.clientId
        ? await readClientSecret(options.environment)
        : undefined;
    const serverConfig = {
      type: transport,
      url: commandOrUrl,
      headers,
      oauth,
    } as const;

    await addMcpConfig(name, serverConfig, scope, options.authority);
    if (clientSecret) {
      saveMcpClientSecret(
        options.authority.homeContext,
        name,
        serverConfig,
        clientSecret,
      );
    }

    stdout.write(
      `Added ${transport.toUpperCase()} MCP server ${name} with URL: ${commandOrUrl} to ${scope} config\n`,
    );
    if (headers) {
      stdout.write("Headers:\n");
      for (const key of Object.keys(headers)) {
        stdout.write(`  ${key}: ${redactMcpDisplayValue(key, headers[key])}\n`);
      }
    }
    stdout.write(
      `File modified: ${describeMcpConfigFilePath(scope, options.authority)}\n`,
    );
    return;
  }

  if (options.clientId || options.clientSecret || options.xaa) {
    stderr.write(
      "Warning: --client-id, --client-secret, and --xaa are only supported for HTTP/SSE transports and will be ignored for stdio.\n",
    );
  }

  if (!transportExplicit && looksLikeUrl) {
    stderr.write(
      `\nWarning: The command "${commandOrUrl}" looks like a URL, but is being interpreted as a stdio server as --transport was not specified.\n`,
    );
    stderr.write(
      `If this is an HTTP server, use: agenc mcp add --transport http ${name} ${commandOrUrl}\n`,
    );
    stderr.write(
      `If this is an SSE server, use: agenc mcp add --transport sse ${name} ${commandOrUrl}\n`,
    );
  }

  const env = parseEnvVars(options.env);
  await addMcpConfig(
    name,
    { type: "stdio", command: commandOrUrl, args: [...args], env },
    scope,
    options.authority,
  );
  stdout.write(
    `Added stdio MCP server ${name} with command: ${commandOrUrl} ${args.join(" ")} to ${scope} config\n`,
  );
  stdout.write(
    `File modified: ${describeMcpConfigFilePath(scope, options.authority)}\n`,
  );
}
