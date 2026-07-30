import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import ignore, { type Ignore } from "ignore";

import { redactSecrets } from "../../secrets/sanitizer.js";
import {
  CODE_PREDICTION_MAX_FILE_BYTES,
  CODE_PREDICTION_MODEL_CONTEXT_MAX_BYTES,
  CODE_PREDICTION_PROTOCOL_MAX_BYTES,
  type CodePredictionRequest,
  type CodePredictionSuppressionReason,
} from "./types.js";

const PREFIX_BYTES = 20 * 1024;
const HEADER_BYTES = 4 * 1024;
const SUFFIX_BYTES = 8 * 1024;
const RELATED_BUFFER_BYTES = 8 * 1024;
const AUXILIARY_TEXT_BYTES = 4 * 1024;

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".envrc",
  ".git-credentials",
  ".gitconfig",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".vault-token",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "secrets.yml",
  "secrets.yaml",
]);

/**
 * Directory names whose contents must never enter speculative prediction
 * requests. Basename-only checks miss credential stores whose files have
 * harmless names such as `config` or `hosts.yml`.
 */
const SENSITIVE_DIRECTORY_SEGMENTS = new Set([
  ".agenc",
  ".aws",
  ".azure",
  ".direnv",
  ".docker",
  ".git",
  ".gnupg",
  ".hg",
  ".kube",
  ".password-store",
  ".pulumi",
  ".secrets",
  ".ssh",
  ".svn",
  ".terraform",
  "credentials",
  "secrets",
]);

const SENSITIVE_CONFIG_DIRECTORIES = new Set(["gcloud", "gh", "hub", "op"]);

const SENSITIVE_EXTENSIONS = [
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".tfstate",
  ".tfstate.backup",
] as const;

export interface PreparedCodePredictionContext {
  readonly relativePath: string;
  readonly language?: string;
  readonly cursor: CodePredictionRequest["cursor"];
  readonly prefix: string;
  readonly suffix: string;
  readonly header?: string;
  readonly diagnostics?: string;
  readonly latestIntent?: string;
  readonly relatedBuffers: readonly {
    readonly path: string;
    readonly language?: string;
    readonly content: string;
  }[];
}

export interface PredictionIgnoreMatcher {
  readonly ignores: (path: string) => boolean;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes
    ? value
    : bytes
        .subarray(0, maxBytes)
        .toString("utf8")
        .replace(/\uFFFD+$/u, "");
}

function utf8Suffix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

export function predictionPayloadBytes(request: CodePredictionRequest): number {
  return utf8ByteLength(JSON.stringify(request));
}

export function isPathInsideWorkspace(
  workspaceRoot: string,
  candidatePath: string,
): boolean {
  if (!isAbsolute(candidatePath)) return false;
  const root = resolve(workspaceRoot);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export function isSensitivePredictionPath(path: string): boolean {
  const lower = basename(path).toLowerCase();
  if (SENSITIVE_BASENAMES.has(lower)) return true;
  if (lower.startsWith(".env.")) return true;
  if (SENSITIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return true;
  }
  const segments = path
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => SENSITIVE_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }
  return segments.some(
    (segment, index) =>
      segment === ".config" &&
      SENSITIVE_CONFIG_DIRECTORIES.has(segments[index + 1] ?? ""),
  );
}

export function containsLikelySecret(value: string): boolean {
  return redactSecrets(value) !== value;
}

export function compilePredictionIgnore(
  patterns: readonly string[],
): Ignore | undefined {
  const normalized = patterns
    .flatMap((pattern) => pattern.split(/\r?\n/u))
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0 && !pattern.startsWith("#"));
  return normalized.length > 0 ? ignore().add(normalized) : undefined;
}

export function isCodePredictionRelatedBufferAllowed(params: {
  readonly buffer: NonNullable<
    CodePredictionRequest["relatedBuffers"]
  >[number];
  readonly workspaceRoot: string;
  readonly ignored?: PredictionIgnoreMatcher;
}): boolean {
  const { buffer, workspaceRoot } = params;
  if (
    !isPathInsideWorkspace(workspaceRoot, buffer.path) ||
    isSensitivePredictionPath(buffer.path)
  ) {
    return false;
  }
  const candidateContent = `${buffer.path}\n${buffer.language ?? ""}\n${buffer.content}`;
  if (
    candidateContent.includes("\0") ||
    containsLikelySecret(candidateContent)
  ) {
    return false;
  }
  const relatedPath = relative(
    resolve(workspaceRoot),
    resolve(buffer.path),
  )
    .split(sep)
    .join("/");
  return params.ignored?.ignores(relatedPath) !== true;
}

export function prepareCodePredictionContext(params: {
  readonly request: CodePredictionRequest;
  readonly workspaceRoot: string;
  readonly ignored?: PredictionIgnoreMatcher;
}):
  | { readonly context: PreparedCodePredictionContext }
  | { readonly reason: CodePredictionSuppressionReason } {
  const { request, workspaceRoot } = params;
  if (predictionPayloadBytes(request) > CODE_PREDICTION_PROTOCOL_MAX_BYTES) {
    return { reason: "payload_too_large" };
  }
  if (!isPathInsideWorkspace(workspaceRoot, request.path)) {
    return { reason: "outside_workspace" };
  }
  const relativePath = relative(resolve(workspaceRoot), resolve(request.path))
    .split(sep)
    .join("/");
  if (
    isSensitivePredictionPath(request.path) ||
    params.ignored?.ignores(relativePath)
  ) {
    return { reason: "sensitive_path" };
  }
  if (request.fileBytes > CODE_PREDICTION_MAX_FILE_BYTES) {
    return { reason: "file_too_large" };
  }
  const candidateContent = [
    relativePath,
    request.language ?? "",
    request.header ?? "",
    request.prefix,
    request.suffix,
    request.latestIntent ?? "",
    ...(request.diagnostics ?? []).map((diagnostic) => diagnostic.message),
  ].join("\n");
  if (candidateContent.includes("\0")) return { reason: "binary_content" };
  if (containsLikelySecret(candidateContent)) {
    return { reason: "sensitive_path" };
  }

  const context: PreparedCodePredictionContext = {
    relativePath,
    ...(request.language !== undefined ? { language: request.language } : {}),
    cursor: request.cursor,
    prefix: utf8Suffix(request.prefix, PREFIX_BYTES),
    suffix: utf8Prefix(request.suffix, SUFFIX_BYTES),
    ...(request.header !== undefined
      ? { header: utf8Prefix(request.header, HEADER_BYTES) }
      : {}),
    ...(request.diagnostics?.length
      ? {
          diagnostics: utf8Prefix(
            request.diagnostics
              .slice(0, 8)
              .map(
                (diagnostic) =>
                  `${diagnostic.severity ?? "information"}: ${diagnostic.message}`,
              )
              .join("\n"),
            AUXILIARY_TEXT_BYTES,
          ),
        }
      : {}),
    ...(request.latestIntent !== undefined
      ? {
          latestIntent: utf8Prefix(request.latestIntent, AUXILIARY_TEXT_BYTES),
        }
      : {}),
    relatedBuffers: (request.relatedBuffers ?? [])
      .filter((buffer) =>
        isCodePredictionRelatedBufferAllowed({
          buffer,
          workspaceRoot,
          ...(params.ignored !== undefined ? { ignored: params.ignored } : {}),
        }),
      )
      .slice(0, 2)
      .map((buffer) => ({
        path: relative(resolve(workspaceRoot), resolve(buffer.path))
          .split(sep)
          .join("/"),
        ...(buffer.language !== undefined ? { language: buffer.language } : {}),
        content: utf8Prefix(buffer.content, RELATED_BUFFER_BYTES),
      })),
  };
  if (
    utf8ByteLength(JSON.stringify(context)) >
    CODE_PREDICTION_MODEL_CONTEXT_MAX_BYTES
  ) {
    return {
      context: {
        ...context,
        relatedBuffers: [],
        diagnostics: undefined,
        latestIntent: undefined,
      },
    };
  }
  return { context };
}

export function buildCodePredictionMessages(
  context: PreparedCodePredictionContext,
): {
  readonly systemPrompt: string;
  readonly userPrompt: string;
} {
  const systemPrompt = [
    "You are a low-latency code completion engine.",
    "Return only the exact text to insert at the cursor.",
    "Do not use Markdown fences, commentary, XML tags, or surrounding quotes.",
    "Preserve indentation and stop as soon as the local completion is useful.",
    "An empty response is valid when no confident completion exists.",
  ].join(" ");
  const related =
    context.relatedBuffers.length === 0
      ? ""
      : `\n<related_buffers>\n${context.relatedBuffers
          .map(
            (buffer) =>
              `<buffer path=${JSON.stringify(buffer.path)} language=${JSON.stringify(buffer.language ?? "")}>\n${buffer.content}\n</buffer>`,
          )
          .join("\n")}\n</related_buffers>`;
  const userPrompt = [
    `<file path=${JSON.stringify(context.relativePath)} language=${JSON.stringify(context.language ?? "")}>`,
    context.header ? `<header>\n${context.header}\n</header>` : "",
    context.latestIntent
      ? `<latest_user_intent>\n${context.latestIntent}\n</latest_user_intent>`
      : "",
    context.diagnostics
      ? `<diagnostics>\n${context.diagnostics}\n</diagnostics>`
      : "",
    `<prefix>\n${context.prefix}\n</prefix>`,
    `<cursor line=${context.cursor.line} byte_column=${context.cursor.byteColumn} />`,
    `<suffix>\n${context.suffix}\n</suffix>`,
    related,
    "</file>",
  ]
    .filter(Boolean)
    .join("\n");
  return { systemPrompt, userPrompt };
}

export function normalizePredictionText(value: string): string {
  if (value.length === 0) return "";
  const fenced = value.match(
    /^```(?:[A-Za-z0-9_+.-]+)?\r?\n([\s\S]*?)\r?\n```[\t ]*$/u,
  );
  return fenced?.[1] ?? value;
}
