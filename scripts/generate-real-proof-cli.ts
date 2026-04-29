import path from "node:path";
import { PublicKey } from "@solana/web3.js";

export const DEFAULT_PROGRAM_ID = "6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab";
export const DEFAULT_FIXTURE_PATH = "tests/fixtures/real-groth16-proof.json";

export interface GenerateRealProofOptions {
  programId: string;
  fixturePath: string;
  proverEndpoint: string;
  proverTimeoutMs?: number;
  proverHeaders: Record<string, string>;
}

interface ParsedCliValue {
  nextIndex: number;
  value: string;
}

const HELP_TEXT = [
  "Usage: generate-real-proof [options]",
  "",
  "Required:",
  "  --prover-endpoint <url>        Remote prover endpoint (or set AGENC_PROVER_ENDPOINT)",
  "",
  "Options:",
  `  --program-id <pubkey>          Coordination program ID (default: ${DEFAULT_PROGRAM_ID})`,
  "  --output <path>                Fixture output path",
  "  --prover-timeout-ms <int>      Remote prover timeout in milliseconds",
  "  --header name=value            Repeatable remote prover header",
  "",
  "Environment:",
  `  AGENC_PROGRAM_ID               Coordination program ID (default: ${DEFAULT_PROGRAM_ID})`,
  "  AGENC_REAL_PROOF_FIXTURE_PATH  Fixture output path",
  "  AGENC_PROVER_ENDPOINT          Remote prover endpoint",
  "  AGENC_PROVER_TIMEOUT_MS        Remote prover timeout in milliseconds",
  "  AGENC_PROVER_API_KEY           Adds x-api-key header automatically",
  '  AGENC_PROVER_HEADERS_JSON      JSON object of additional headers, e.g. {"authorization":"Bearer ..."}',
].join("\n");

function parseProgramId(raw: string, flag: string): string {
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function parseEndpoint(raw: string, flag: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid ${flag} protocol: ${parsed.protocol}`);
  }
  return trimmed;
}

function parseHeadersJson(raw: string, flag: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${flag} value: expected JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid ${flag} value: expected JSON object`);
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error(`invalid ${flag} value: header names must be non-empty`);
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `invalid ${flag} value: header ${normalizedKey} must be a non-empty string`,
      );
    }
    headers[normalizedKey] = value;
  }
  return headers;
}

function resolveDefaultProverHeaders(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.AGENC_PROVER_API_KEY) {
    headers["x-api-key"] = env.AGENC_PROVER_API_KEY;
  }
  if (env.AGENC_PROVER_HEADERS_JSON) {
    Object.assign(
      headers,
      parseHeadersJson(
        env.AGENC_PROVER_HEADERS_JSON,
        "AGENC_PROVER_HEADERS_JSON",
      ),
    );
  }
  return headers;
}

function resolveDefaultOptions(
  env: NodeJS.ProcessEnv,
  cwd: string,
): GenerateRealProofOptions {
  return {
    programId: parseProgramId(
      env.AGENC_PROGRAM_ID ?? DEFAULT_PROGRAM_ID,
      "AGENC_PROGRAM_ID",
    ),
    fixturePath: env.AGENC_REAL_PROOF_FIXTURE_PATH
      ? path.resolve(cwd, env.AGENC_REAL_PROOF_FIXTURE_PATH)
      : path.resolve(cwd, DEFAULT_FIXTURE_PATH),
    proverEndpoint: env.AGENC_PROVER_ENDPOINT
      ? parseEndpoint(env.AGENC_PROVER_ENDPOINT, "AGENC_PROVER_ENDPOINT")
      : "",
    proverTimeoutMs: env.AGENC_PROVER_TIMEOUT_MS
      ? parsePositiveInt(env.AGENC_PROVER_TIMEOUT_MS, "AGENC_PROVER_TIMEOUT_MS")
      : undefined,
    proverHeaders: resolveDefaultProverHeaders(env),
  };
}

function readCliValue(argv: string[], index: number, flag: string): ParsedCliValue {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`missing ${flag} value`);
  }
  return { nextIndex: index + 1, value };
}

function applyCliOption(
  options: GenerateRealProofOptions,
  flag: string,
  value: string,
  cwd: string,
): void {
  switch (flag) {
    case "--program-id":
      options.programId = parseProgramId(value, flag);
      break;
    case "--output":
      options.fixturePath = path.resolve(cwd, value);
      break;
    case "--prover-endpoint":
      options.proverEndpoint = parseEndpoint(value, flag);
      break;
    case "--prover-timeout-ms":
      options.proverTimeoutMs = parsePositiveInt(value, flag);
      break;
    case "--header": {
      const [key, ...valueParts] = value.split("=");
      const normalizedKey = key?.trim() ?? "";
      const headerValue = valueParts.join("=");
      if (!normalizedKey || !headerValue) {
        throw new Error(`invalid --header value: ${value}`);
      }
      options.proverHeaders[normalizedKey] = headerValue;
      break;
    }
    default:
      throw new Error(`unknown option: ${flag}`);
  }
}

function printHelpAndExit(): never {
  console.log(HELP_TEXT);
  process.exit(0);
}

export function parseGenerateRealProofArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): GenerateRealProofOptions {
  const options = resolveDefaultOptions(env, cwd);

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelpAndExit();
    }

    const parsedValue = readCliValue(argv, index, arg);
    applyCliOption(options, arg, parsedValue.value, cwd);
    index = parsedValue.nextIndex + 1;
  }

  if (!options.proverEndpoint) {
    throw new Error(
      "missing remote prover endpoint: pass --prover-endpoint or set AGENC_PROVER_ENDPOINT",
    );
  }

  return options;
}
