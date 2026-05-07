import type { Writable } from "node:stream";

import {
  acquireIdpIdToken,
  clearIdpClientSecret,
  clearIdpIdToken,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  issuerKey,
  saveIdpClientSecret,
  saveIdpIdTokenFromJwt,
} from "../../services/mcp/xaaIdpLogin.js";
import { errorMessage } from "../../utils/errors.js";
import { updateSettingsForSource } from "../../utils/settings/settings.js";

export interface McpXaaIo {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface McpXaaOptions {
  readonly io: McpXaaIo;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runMcpXaaCommand(
  argv: readonly string[],
  options: McpXaaOptions,
): Promise<void> {
  const action = argv[0];
  const rest = argv.slice(1);
  switch (action) {
    case "setup":
      await runXaaSetup(rest, options);
      return;
    case "login":
      await runXaaLogin(rest, options);
      return;
    case "show":
      assertNoPositionals(rest, "Usage: agenc mcp xaa show");
      runXaaShow(options);
      return;
    case "clear":
      assertNoPositionals(rest, "Usage: agenc mcp xaa clear");
      runXaaClear(options);
      return;
    default:
      throw new Error(
        "Usage: agenc mcp xaa <setup|login|show|clear>",
      );
  }
}

function parseXaaOptions(
  argv: readonly string[],
  spec: {
    readonly value?: ReadonlySet<string>;
    readonly boolean?: ReadonlySet<string>;
  },
): {
  readonly options: Record<string, string>;
  readonly flags: Set<string>;
  readonly positionals: string[];
} {
  const valueOptions = spec.value ?? new Set<string>();
  const booleanOptions = spec.boolean ?? new Set<string>();
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      const trimmed = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
      const eq = trimmed.indexOf("=");
      const rawName = eq === -1 ? trimmed : trimmed.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : trimmed.slice(eq + 1);
      const name = normalizeXaaOptionName(rawName);
      if (booleanOptions.has(name)) {
        if (inlineValue !== undefined) {
          throw new Error(`Option --${name} does not take a value`);
        }
        flags.add(name);
        continue;
      }
      if (valueOptions.has(name)) {
        const value = inlineValue ?? argv[++i];
        if (value === undefined) throw new Error(`Missing value for --${name}`);
        options[name] = value;
        continue;
      }
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  return { options, flags, positionals };
}

function normalizeXaaOptionName(name: string): string {
  switch (name) {
    case "client-id":
      return "clientId";
    case "client-secret":
      return "clientSecret";
    case "callback-port":
      return "callbackPort";
    case "id-token":
      return "idToken";
    default:
      return name;
  }
}

async function runXaaSetup(
  argv: readonly string[],
  { env = process.env, io }: McpXaaOptions,
): Promise<void> {
  const parsed = parseXaaOptions(argv, {
    value: new Set(["issuer", "clientId", "callbackPort"]),
    boolean: new Set(["clientSecret"]),
  });
  assertNoPositionals(
    parsed.positionals,
    "Usage: agenc mcp xaa setup --issuer <url> --client-id <id>",
  );
  const issuer = parsed.options.issuer;
  const clientId = parsed.options.clientId;
  if (!issuer) throw new Error("Error: --issuer is required");
  if (!clientId) throw new Error("Error: --client-id is required");

  parseHttpsOrLoopbackIssuer(issuer);
  const callbackPort = parseCallbackPort(parsed.options.callbackPort);
  const secret = parsed.flags.has("clientSecret")
    ? env.MCP_XAA_IDP_CLIENT_SECRET
    : undefined;
  if (parsed.flags.has("clientSecret") && !secret) {
    throw new Error(
      "Error: --client-secret requires MCP_XAA_IDP_CLIENT_SECRET env var",
    );
  }

  const old = getXaaIdpSettings();
  const oldIssuer = old?.issuer;
  const oldClientId = old?.clientId;
  const { error } = updateSettingsForSource("userSettings", {
    xaaIdp: {
      issuer,
      clientId,
      callbackPort,
    },
  });
  if (error) {
    throw new Error(`Error writing settings: ${error.message}`);
  }

  if (oldIssuer) {
    if (issuerKey(oldIssuer) !== issuerKey(issuer)) {
      clearIdpIdToken(oldIssuer);
      clearIdpClientSecret(oldIssuer);
    } else if (oldClientId !== clientId) {
      clearIdpIdToken(oldIssuer);
      clearIdpClientSecret(oldIssuer);
    }
  }

  if (secret) {
    const { success, warning } = saveIdpClientSecret(issuer, secret);
    if (!success) {
      throw new Error(
        `Error: settings written but keychain save failed${warning ? ` - ${warning}` : ""}. ` +
          "Re-run with --client-secret once keychain is available.",
      );
    }
  }

  io.stdout.write(`XAA IdP connection configured for ${issuer}\n`);
}

async function runXaaLogin(
  argv: readonly string[],
  { io }: McpXaaOptions,
): Promise<void> {
  const parsed = parseXaaOptions(argv, {
    value: new Set(["idToken"]),
    boolean: new Set(["force"]),
  });
  assertNoPositionals(parsed.positionals, "Usage: agenc mcp xaa login");
  const idp = getXaaIdpSettings();
  if (!idp) {
    throw new Error("Error: no XAA IdP connection. Run 'agenc mcp xaa setup' first.");
  }

  const idToken = parsed.options.idToken;
  if (idToken) {
    const expiresAt = saveIdpIdTokenFromJwt(idp.issuer, idToken);
    io.stdout.write(
      `id_token cached for ${idp.issuer} (expires ${new Date(expiresAt).toISOString()})\n`,
    );
    return;
  }

  if (parsed.flags.has("force")) {
    clearIdpIdToken(idp.issuer);
  }

  if (getCachedIdpIdToken(idp.issuer) !== undefined) {
    io.stdout.write(
      `Already logged in to ${idp.issuer} (cached id_token still valid). Use --force to re-login.\n`,
    );
    return;
  }

  io.stdout.write(`Opening browser for IdP login at ${idp.issuer}\n`);
  try {
    await acquireIdpIdToken({
      idpIssuer: idp.issuer,
      idpClientId: idp.clientId,
      idpClientSecret: getIdpClientSecret(idp.issuer),
      callbackPort: idp.callbackPort,
      onAuthorizationUrl: url => {
        io.stdout.write(`If the browser did not open, visit:\n  ${url}\n`);
      },
    });
    io.stdout.write(
      "Logged in. MCP servers with --xaa will now authenticate silently.\n",
    );
  } catch (error) {
    throw new Error(`IdP login failed: ${errorMessage(error)}`);
  }
}

function runXaaShow({ io }: McpXaaOptions): void {
  const idp = getXaaIdpSettings();
  if (!idp) {
    io.stdout.write("No XAA IdP connection configured.\n");
    return;
  }
  const hasSecret = getIdpClientSecret(idp.issuer) !== undefined;
  const hasIdToken = getCachedIdpIdToken(idp.issuer) !== undefined;
  io.stdout.write(`Issuer:        ${idp.issuer}\n`);
  io.stdout.write(`Client ID:     ${idp.clientId}\n`);
  if (idp.callbackPort !== undefined) {
    io.stdout.write(`Callback port: ${idp.callbackPort}\n`);
  }
  io.stdout.write(
    `Client secret: ${hasSecret ? "(stored in keychain)" : "(not set - PKCE-only)"}\n`,
  );
  io.stdout.write(
    `Logged in:     ${hasIdToken ? "yes (id_token cached)" : "no - run 'agenc mcp xaa login'"}\n`,
  );
}

function runXaaClear({ io }: McpXaaOptions): void {
  const idp = getXaaIdpSettings();
  const { error } = updateSettingsForSource("userSettings", {
    xaaIdp: undefined,
  });
  if (error) {
    throw new Error(`Error writing settings: ${error.message}`);
  }
  if (idp) {
    clearIdpIdToken(idp.issuer);
    clearIdpClientSecret(idp.issuer);
  }
  io.stdout.write("XAA IdP connection cleared\n");
}

function parseHttpsOrLoopbackIssuer(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Error: --issuer must be a valid URL (got "${value}")`);
  }
  const isLoopback =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error(
      `Error: --issuer must use https:// (got "${url.protocol}//${url.host}")`,
    );
  }
  return url;
}

function parseCallbackPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("Error: --callback-port must be a valid TCP port");
  }
  return parsed;
}

function assertNoPositionals(values: readonly string[], usage: string): void {
  if (values.length > 0) throw new Error(usage);
}
