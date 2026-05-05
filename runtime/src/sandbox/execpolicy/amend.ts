import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type Lockfile = typeof import("proper-lockfile");

import type { Decision } from "./decision.js";
import {
  networkRuleProtocolAsPolicyString,
  normalizeNetworkRuleHost,
  type NetworkRuleProtocol,
} from "./rule.js";

export class AmendError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AmendError";
    this.code = code;
  }
}

const requireCjs = createRequire(import.meta.url);
let cachedLockfile: Lockfile | null = null;

function getLockfile(): Lockfile {
  cachedLockfile ??= requireCjs("proper-lockfile") as Lockfile;
  return cachedLockfile;
}

export function blockingAppendAllowPrefixRule(
  policyPath: string,
  prefix: readonly string[],
): void {
  if (prefix.length === 0) {
    throw new AmendError("empty_prefix", "prefix rule requires at least one token");
  }
  const pattern = `[${prefix.map((token) => JSON.stringify(token)).join(", ")}]`;
  appendRuleLine(policyPath, `prefix_rule(pattern=${pattern}, decision="allow")`);
}

export function blockingAppendNetworkRule(
  policyPath: string,
  host: string,
  protocol: NetworkRuleProtocol,
  decision: Decision,
  justification: string | null = null,
): void {
  let normalizedHost: string;
  try {
    normalizedHost = normalizeNetworkRuleHost(host);
  } catch (error) {
    throw new AmendError(
      "invalid_network_rule",
      `invalid network rule: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (justification !== null && justification.trim().length === 0) {
    throw new AmendError(
      "invalid_network_rule",
      "invalid network rule: justification cannot be empty",
    );
  }

  const args = [
    `host=${JSON.stringify(normalizedHost)}`,
    `protocol=${JSON.stringify(networkRuleProtocolAsPolicyString(protocol))}`,
    `decision=${JSON.stringify(decision === "forbidden" ? "deny" : decision)}`,
  ];
  if (justification !== null) {
    args.push(`justification=${JSON.stringify(justification)}`);
  }
  appendRuleLine(policyPath, `network_rule(${args.join(", ")})`);
}

function appendRuleLine(policyPath: string, line: string): void {
  const dir = path.dirname(policyPath);
  if (dir === policyPath || dir.length === 0) {
    throw new AmendError("missing_parent", `policy path has no parent: ${policyPath}`);
  }
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new AmendError(
        "create_policy_dir",
        `failed to create policy directory ${dir}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  appendLockedLine(policyPath, line);
}

function appendLockedLine(policyPath: string, line: string): void {
  try {
    fs.closeSync(fs.openSync(policyPath, "a+"));
  } catch (error) {
    throw new AmendError(
      "open_policy_file",
      `failed to open policy file ${policyPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let release: (() => void) | null = null;
  try {
    release = getLockfile().lockSync(policyPath, { realpath: false });
  } catch (error) {
    throw new AmendError(
      "lock_policy_file",
      `failed to lock policy file ${policyPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    let contents: string;
    try {
      contents = fs.readFileSync(policyPath, "utf8");
    } catch (error) {
      throw new AmendError(
        "read_policy_file",
        `failed to read policy file ${policyPath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (contents.split(/\r?\n/u).some((existing) => existing === line)) {
      return;
    }
    const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    try {
      fs.appendFileSync(policyPath, `${prefix}${line}\n`);
    } catch (error) {
      throw new AmendError(
        "write_policy_file",
        `failed to write to policy file ${policyPath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  } finally {
    release?.();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
