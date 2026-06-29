/**
 * Top-level auth CLI commands for the local AgenC runtime.
 *
 * `agenc login`, `agenc logout`, and `agenc whoami` use the configured
 * AuthBackend directly so CLI auth state and daemon auth state share the same
 * persistence path.
 */

import { spawn } from "node:child_process";

import { createAuthBackend } from "../auth/selection.js";
import type { AuthBackend, AuthIdentity } from "../auth/backend.js";
import type { RemoteAuthBackendOptions } from "../auth/backends/remote.js";
import { loadConfig } from "../config/loader.js";
import { resolveAgencHome } from "../config/env.js";

export type AgenCAuthCliCommand =
  | { readonly kind: "login" }
  | { readonly kind: "logout" }
  | { readonly kind: "whoami" }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCAuthCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly stdin?: Pick<
    NodeJS.ReadStream,
    "isTTY" | "once" | "pause" | "resume"
  >;
  readonly openUrl?: (url: string) => void | Promise<void>;
}

export interface AgenCAuthCliOptions {
  readonly agencHome?: string;
  readonly backend?: AuthBackend;
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: AgenCAuthCliIo;
  readonly remote?: RemoteAuthBackendOptions;
}

export function formatAgenCAuthCliHelpText(): string {
  return [
    "Usage: agenc <login|logout|whoami>",
    "",
    "Commands:",
    "  login     Sign in using the configured AgenC auth backend",
    "  logout    Clear the current AgenC auth session",
    "  whoami    Show the current AgenC auth identity",
    "",
    "Examples:",
    "  agenc login",
    "  AGENC_AUTH_BACKEND=remote agenc login",
    "  agenc whoami",
    "  agenc logout",
  ].join("\n");
}

export function parseAgenCAuthCliArgs(
  argv: readonly string[],
): AgenCAuthCliCommand | null {
  const action = argv[0];
  if (action !== "login" && action !== "logout" && action !== "whoami") {
    return null;
  }
  const rest = argv.slice(1);
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return { kind: "help", text: formatAgenCAuthCliHelpText() };
  }
  if (rest.length > 0) {
    return {
      kind: "error",
      message: `auth command '${action}' does not accept arguments`,
    };
  }
  return { kind: action };
}

export async function runAgenCAuthCli(
  command: AgenCAuthCliCommand,
  options: AgenCAuthCliOptions = {},
): Promise<number> {
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    openUrl: openUrlInBrowser,
  };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCAuthCliHelpText()}\n`);
      return 1;
    case "login":
    case "logout":
    case "whoami":
      return runAuthBackendCommand(command.kind, io, options);
  }
}

async function runAuthBackendCommand(
  action: "login" | "logout" | "whoami",
  io: AgenCAuthCliIo,
  options: AgenCAuthCliOptions,
): Promise<number> {
  try {
    const backend = await resolveAgenCAuthBackend(options, io);
    if (action === "login") {
      const result = await backend.login({ sessionId: "cli" });
      io.stdout.write(
        `Logged in as ${formatAgenCAuthIdentity(result.identity)}\n`,
      );
      return 0;
    }
    if (action === "logout") {
      await backend.logout({ sessionId: "cli" });
      io.stdout.write("Logged out\n");
      return 0;
    }

    const result = await backend.whoami({ sessionId: "cli" });
    if (!result.authenticated) {
      io.stdout.write("Not logged in\n");
      return 1;
    }
    io.stdout.write(`${formatAgenCAuthIdentity(result.identity)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

async function resolveAgenCAuthBackend(
  options: AgenCAuthCliOptions,
  io: AgenCAuthCliIo,
): Promise<AuthBackend> {
  if (options.backend !== undefined) return options.backend;
  const env = options.env ?? process.env;
  const agencHome = options.agencHome ?? resolveAgencHome(env);
  const loadedConfig = await loadConfig({
    home: agencHome,
    onWarn: (message) => io.stderr.write(`${message}\n`),
  });
  return createAuthBackend(loadedConfig.config, {
    agencHome,
    env,
    remote: {
      ...remoteAuthCliOptions(io),
      ...(options.remote ?? {}),
    },
  });
}

function remoteAuthCliOptions(
  io: AgenCAuthCliIo,
): Pick<RemoteAuthBackendOptions, "onDeviceCode"> {
  return {
    onDeviceCode: async ({ verificationUri, userCode }) => {
      if (verificationUri !== undefined) {
        if (io.stdin?.isTTY === true) {
          io.stdout.write("Sign in with Google to continue.\n");
          io.stdout.write("Press Enter to open the browser.\n");
          io.stdout.write("If it does not open, copy this URL:\n");
          io.stdout.write(`${verificationUri}\n`);
          await waitForEnter(io.stdin);
          try {
            await (io.openUrl ?? openUrlInBrowser)(verificationUri);
            io.stdout.write(
              "Browser opened. Complete sign in there, then return here.\n",
            );
          } catch {
            io.stdout.write(
              `Could not open the browser automatically. Open this URL: ${verificationUri}\n`,
            );
          }
          return;
        }
        io.stdout.write(
          `Open this URL in your browser to sign in: ${verificationUri}\n`,
        );
      }
      if (userCode !== undefined) {
        io.stdout.write(`Enter code: ${userCode}\n`);
      }
    },
  };
}

async function waitForEnter(
  stdin: Pick<NodeJS.ReadStream, "once" | "pause" | "resume">,
): Promise<void> {
  await new Promise<void>((resolve) => {
    stdin.resume();
    stdin.once("data", () => {
      stdin.pause();
      resolve();
    });
  });
}

async function openUrlInBrowser(url: string): Promise<void> {
  const { command, args } = browserOpenCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function browserOpenCommand(url: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function formatAgenCAuthIdentity(
  identity: AuthIdentity | undefined,
): string {
  if (identity === undefined) return "AgenC user";
  const name =
    identity.displayName?.trim() ||
    identity.email?.trim() ||
    identity.accountId?.trim() ||
    "AgenC user";
  const detail = [
    identity.accountId?.trim() ? `id=${identity.accountId.trim()}` : undefined,
    identity.email?.trim() ? `email=${identity.email.trim()}` : undefined,
    identity.plan?.trim() ? `plan=${identity.plan.trim()}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return detail.length > 0 ? `${name} (${detail.join(", ")})` : name;
}
