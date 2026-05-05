#!/usr/bin/env node
// Fail when the sibling SDK daemon method unions drift from agenc-core's
// daemon protocol registry.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUEST_METHOD_CONST = "AGENC_DAEMON_METHODS";
const NOTIFICATION_METHOD_CONST = "AGENC_DAEMON_NOTIFICATION_METHODS";

export function extractStringArrayConst(source, constName) {
  const match = new RegExp(
    `export\\s+const\\s+${escapeRegExp(constName)}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const\\s*;`,
  ).exec(source);
  if (!match) throw new Error(`missing const array: ${constName}`);
  return extractStringLiterals(match[1]);
}

export function extractTypeUnionStringLiterals(source, typeName) {
  const match = new RegExp(
    `export\\s+type\\s+${escapeRegExp(typeName)}\\s*=([\\s\\S]*?);`,
  ).exec(source);
  if (!match) throw new Error(`missing type union: ${typeName}`);
  return extractStringLiterals(match[1]);
}

export function extractInterfaceMethodKeys(source, interfaceName) {
  const match = new RegExp(
    `export\\s+interface\\s+${escapeRegExp(interfaceName)}\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!match) throw new Error(`missing interface: ${interfaceName}`);
  const keys = [];
  const keyRe =
    /readonly\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/g;
  let keyMatch;
  while ((keyMatch = keyRe.exec(match[1])) !== null) {
    keys.push(keyMatch[1] ?? keyMatch[2] ?? keyMatch[3]);
  }
  return keys;
}

export function compareOrderedLiterals(label, expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  const orderMatches =
    missing.length === 0 &&
    extra.length === 0 &&
    expected.length === actual.length &&
    expected.every((value, index) => actual[index] === value);
  return {
    label,
    expected,
    actual,
    missing,
    extra,
    orderMatches,
    ok: missing.length === 0 && extra.length === 0 && orderMatches,
  };
}

export function buildSdkDaemonMethodReport(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const sdkRoot = path.resolve(
    options.sdkRoot ?? resolveSiblingSdkRoot(root),
  );
  const coreProtocolPath =
    options.coreProtocolPath ??
    path.join(root, "runtime", "src", "app-server", "protocol", "index.ts");
  const sdkDaemonPath =
    options.sdkDaemonPath ?? path.join(sdkRoot, "src", "daemon.ts");

  const coreSource = readFile(coreProtocolPath);
  const sdkSource = readFile(sdkDaemonPath);
  const requestMethods = extractStringArrayConst(
    coreSource,
    REQUEST_METHOD_CONST,
  );
  const notificationMethods = extractStringArrayConst(
    coreSource,
    NOTIFICATION_METHOD_CONST,
  );

  const comparisons = [
    compareOrderedLiterals(
      "AgenCDaemonMethod",
      requestMethods,
      extractTypeUnionStringLiterals(sdkSource, "AgenCDaemonMethod"),
    ),
    compareOrderedLiterals(
      "AgenCDaemonParamsByMethod",
      requestMethods,
      extractInterfaceMethodKeys(sdkSource, "AgenCDaemonParamsByMethod"),
    ),
    compareOrderedLiterals(
      "AgenCDaemonResultByMethod",
      requestMethods,
      extractInterfaceMethodKeys(sdkSource, "AgenCDaemonResultByMethod"),
    ),
    compareOrderedLiterals(
      "AgenCDaemonNotificationMethod",
      notificationMethods,
      extractTypeUnionStringLiterals(
        sdkSource,
        "AgenCDaemonNotificationMethod",
      ),
    ),
    compareOrderedLiterals(
      "AgenCDaemonNotificationParamsByMethod",
      notificationMethods,
      extractInterfaceMethodKeys(
        sdkSource,
        "AgenCDaemonNotificationParamsByMethod",
      ),
    ),
  ];

  return {
    root,
    sdkRoot,
    coreProtocolPath,
    sdkDaemonPath,
    requestMethods,
    notificationMethods,
    comparisons,
    ok: comparisons.every((comparison) => comparison.ok),
  };
}

function extractStringLiterals(source) {
  const values = [];
  const literalRe = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match;
  while ((match = literalRe.exec(source)) !== null) {
    values.push(unescapeLiteral(match[1] ?? match[2]));
  }
  return values;
}

function unescapeLiteral(value) {
  return value.replace(/\\(["'\\])/g, "$1");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`missing file: ${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

function resolveSiblingSdkRoot(root) {
  const candidates = [
    process.env.AGENC_SDK_ROOT,
    path.resolve(root, "..", "agenc-sdk"),
    path.resolve(root, "..", "..", "agenc-sdk"),
  ].filter(Boolean);

  const mainRoot = mainCheckoutRoot(root);
  if (mainRoot) candidates.push(path.resolve(mainRoot, "..", "agenc-sdk"));

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "src", "daemon.ts"))) {
      return candidate;
    }
  }

  throw new Error(
    "missing sibling agenc-sdk; set AGENC_SDK_ROOT or pass --sdk <path>",
  );
}

function mainCheckoutRoot(root) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const commonDir = path.resolve(root, result.stdout.trim());
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
}

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    sdkRoot: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root requires a value");
      parsed.root = value;
      i += 1;
    } else if (arg === "--sdk") {
      const value = argv[i + 1];
      if (!value) throw new Error("--sdk requires a value");
      parsed.sdkRoot = value;
      i += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function usage() {
  process.stderr.write(
    [
      "Usage: node scripts/check-sdk-daemon-methods.mjs [--root <agenc-core>] [--sdk <agenc-sdk>] [--json]",
      "",
      "Fails when agenc-sdk/src/daemon.ts drifts from runtime/src/app-server/protocol/index.ts.",
    ].join("\n") + "\n",
  );
}

function printReport(report) {
  if (report.ok) {
    process.stdout.write(
      `SDK daemon methods match core registry (${report.requestMethods.length} requests, ${report.notificationMethods.length} notifications)\n`,
    );
    return;
  }

  process.stderr.write(
    "SDK daemon method drift detected between core registry and sibling SDK.\n",
  );
  for (const comparison of report.comparisons) {
    if (comparison.ok) continue;
    process.stderr.write(`\n${comparison.label}:\n`);
    if (comparison.missing.length > 0) {
      process.stderr.write(`  missing: ${comparison.missing.join(", ")}\n`);
    }
    if (comparison.extra.length > 0) {
      process.stderr.write(`  extra: ${comparison.extra.join(", ")}\n`);
    }
    if (
      comparison.missing.length === 0 &&
      comparison.extra.length === 0 &&
      !comparison.orderMatches
    ) {
      process.stderr.write("  order differs from core registry\n");
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const report = buildSdkDaemonMethodReport(args);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printReport(report);
    }
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`SDK daemon method check failed: ${error.message}\n`);
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
