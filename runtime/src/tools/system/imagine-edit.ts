/**
 * Image editing and upscaling for Venice sessions.
 *
 * Venice edits an image from a prompt (`POST /image/edit`, its "inpaint"
 * models) and upscales one 2x or 4x (`POST /image/upscale`); both answer
 * with the image bytes. The route is session-native and fail-closed like
 * ImagineSpeech: a Venice session edits with its own key and nobody else's,
 * the managed AgenC route lends no credential, a model must be an edit model
 * in Venice's live list with a published price (venice-media-models), and
 * the input must be a PNG, JPEG or WebP file inside the workspace. The result
 * lands under the workspace's `.agenc/imagine` directory with the call's
 * published price recorded. The tool is always deferred: a session finds it
 * through system.searchTools.
 *
 * @module
 */

import { constants } from "node:fs";
import { mkdir, open, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { readProviderIdentity } from "../../llm/provider.js";
import {
  resolveProviderApiKeyEnvironment,
  resolveProviderBaseURLEnvironment,
} from "../../llm/registry/provider-ingress.js";
import { checkToolPathPermission } from "../../permissions/path-validation.js";
import { boundTargetFor, observeFileTarget, type ObservedFileTarget } from "../bound-targets.js";
import type { Tool, ToolResult } from "../types.js";
import { readInvokingSession } from "../runtimes/context.js";
import {
  isManagedProviderRoute,
  resolveToolCallAuthority,
  sessionApiKeyRoute,
  type ToolCallAuthority,
  toolCallSession,
  withToolCallTransport,
} from "./session-provider-authority.js";
import { preEffectRefusal } from "../results.js";
import { safeStringify } from "../types.js";
import { redactSensitiveAPIText } from "../../errors/api.js";
import {
  cachedVeniceMediaModels,
  loadVeniceMediaModels,
  type VeniceListAuthority,
  veniceEditPrice,
  veniceUpscalePrice,
  type VeniceMediaModel,
} from "./venice-media-models.js";

export interface ImagineEditToolOptions {
  readonly workspaceRoot: string;
  readonly getSession: () => {
    services?: { provider?: unknown };
  } | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

interface EditBackend {
  readonly baseURL: string;
  readonly bearer: string;
  /** The calling session's authority; its requests use this transport. */
  readonly authority: ToolCallAuthority;
}

const DEFAULT_BASE_URL = "https://api.venice.ai/api/v1";
/** Venice's documented default edit model. */
const DEFAULT_EDIT_MODEL = "firered-image-edit";
const UPSCALE_MODEL = "upscaler";
/**
 * Prices AgenC can use while Venice's list cannot be read (USD; GET
 * /api/v1/models?type=all, 2026-10-20). Any other model needs the list.
 */
const OFFLINE_EDIT_PRICES: ReadonlyMap<string, number> = new Map([["firered-image-edit", 0.04]]);
const OFFLINE_UPSCALE_PRICES: ReadonlyMap<number, number> = new Map([[2, 0.02], [4, 0.08]]);
/** Venice's input limit. */
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const EDIT_TIER = "1K";

function refusal(message: string): ToolResult {
  return preEffectRefusal("ImagineEdit", safeStringify({ error: message }));
}

function json(payload: unknown, isError?: boolean): ToolResult {
  return { content: safeStringify(payload), ...(isError ? { isError: true } : {}) };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The edit route of the session making the call (`args`; a sub-agent runs
 * its parent's tool): its own Venice key with its own URL, or, without a
 * factory key, the canonical Venice key with the canonical URL from its own
 * environment. Never one session's URL with another's key.
 */
function resolveEditBackend(
  opts: ImagineEditToolOptions,
  args?: Readonly<Record<string, unknown>>,
): EditBackend | { readonly error: string } {
  const call = toolCallSession(readInvokingSession(args), opts.getSession);
  const session = call.session;
  const provider = session?.services?.provider;
  if (readProviderIdentity(provider as never) !== "venice" || provider === undefined) {
    return { error: "ImagineEdit edits images only in a Venice session, with that session's own key." };
  }
  if (isManagedProviderRoute(provider)) {
    return { error: "ImagineEdit is not available on the managed AgenC route." };
  }
  const authority = resolveToolCallAuthority("ImagineEdit", call, {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  if ("error" in authority) return authority;
  const own = sessionApiKeyRoute(provider, DEFAULT_BASE_URL);
  if (own !== undefined) return { ...own, authority };
  const env = authority.environment;
  const bearer = resolveProviderApiKeyEnvironment("venice", env)?.value;
  if (bearer === undefined) return { error: "ImagineEdit needs this Venice session's API key." };
  const baseURL = resolveProviderBaseURLEnvironment("venice", env)?.value ?? DEFAULT_BASE_URL;
  try {
    new URL(baseURL);
  } catch {
    return { error: "ImagineEdit endpoint is invalid." };
  }
  return { baseURL: baseURL.replace(/\/+$/, ""), bearer, authority };
}

/** Whose Venice list a call reads: the session's endpoint, key and transport. */
function veniceList(backend: EditBackend): VeniceListAuthority {
  return { baseURL: backend.baseURL, bearer: backend.bearer, transport: backend.authority.transportEnvironment };
}

/** Whether this session has its own image edit route. */
export function hasImagineEditBackend(opts: ImagineEditToolOptions): boolean {
  return !("error" in resolveEditBackend(opts));
}

function upscaleFactor(value: unknown): 2 | 4 | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  return value === 2 || value === 4 ? value : "invalid";
}

/** The published price of one call, from Venice's list or the offline table. */
function callPrice(
  listed: ReadonlyMap<string, VeniceMediaModel> | undefined,
  model: string,
  scale: 2 | 4 | undefined,
): number | undefined {
  if (scale !== undefined) {
    const upscaler = listed?.get(UPSCALE_MODEL);
    return upscaler !== undefined ? veniceUpscalePrice(upscaler, scale) : listed === undefined ? OFFLINE_UPSCALE_PRICES.get(scale) : undefined;
  }
  const row = listed?.get(model);
  if (row !== undefined) return row.type === "inpaint" ? veniceEditPrice(row, EDIT_TIER) : undefined;
  return listed === undefined ? OFFLINE_EDIT_PRICES.get(model) : undefined;
}

function imageType(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

/**
 * The file an image reference names, read literally: a relative reference is
 * taken from the workspace root, and no quote, glob or `~` in it is special.
 * Permission checks and the reader use this same path.
 */
export function imageReferencePath(workspaceRoot: string, ref: string): string {
  return isAbsolute(ref) ? ref : resolve(workspaceRoot, ref);
}

/** Where the file a descriptor holds is now, or undefined when unknown. */
async function openedFilePath(fd: number, opened: { dev: number; ino: number }, path: string): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const location = await readlink(`/proc/self/fd/${fd}`);
      return location.endsWith(" (deleted)") ? undefined : location;
    } catch {
      // Fall back to the path check below.
    }
  }
  try {
    const canonical = await realpath(path);
    const current = await stat(canonical);
    return current.dev === opened.dev && current.ino === opened.ino ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the input image: a regular file inside the workspace, PNG, JPEG or
 * WebP, under 25 MB. Every check is about the file the descriptor holds,
 * which is the file whose bytes are returned: its real path must be inside
 * the workspace and, when the call was bound to an observation of the file
 * before its approval (`expected`), it must be that same file.
 */
export async function readWorkspaceImage(
  workspaceRoot: string,
  ref: string,
  expected?: ObservedFileTarget,
): Promise<
  | { readonly bytes: Buffer; readonly path: string; readonly type: "image/png" | "image/jpeg" | "image/webp" }
  | { readonly error: string }
> {
  let root: string;
  try {
    root = await realpath(workspaceRoot);
  } catch {
    return { error: `image not found: ${ref}` };
  }
  const literal = imageReferencePath(workspaceRoot, ref);
  let handle;
  try {
    // Non-blocking, so a FIFO cannot hold the call; a regular file reads as usual.
    handle = await open(literal, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { error: `image not found: ${ref}` };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { error: "image must be a regular file" };
    const path = await openedFilePath(handle.fd, opened, literal);
    if (path === undefined) return { error: `image changed while it was opened: ${ref}` };
    const inside = relative(root, path);
    if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
      return { error: "image must be a file inside the workspace" };
    }
    if (expected !== undefined && (expected.canonical !== path || expected.identity !== `${opened.dev}:${opened.ino}`)) {
      return {
        error: `image ${ref} is not the file this call was checked against: it changed after the check ` +
          "(for example a link was pointed elsewhere). It was not sent; run the call again.",
      };
    }
    if (opened.size > MAX_INPUT_BYTES) return { error: "image is larger than the 25 MB limit" };
    // Read at most one byte past the limit, whatever the file grows to.
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_INPUT_BYTES) return { error: "image is larger than the 25 MB limit" };
    }
    const bytes = Buffer.from(buffer.subarray(0, length));
    const type = imageType(bytes);
    if (type === undefined) return { error: "image must be a PNG, JPEG or WebP file" };
    return { bytes, path, type };
  } finally {
    await handle.close();
  }
}

async function readCappedImage(response: Response): Promise<Buffer> {
  if (response.body === null) throw new Error("Venice returned no image");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OUTPUT_BYTES) {
      await reader.cancel();
      throw new Error("Venice image exceeds the 64 MiB limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

const EXTENSIONS: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function createImagineEditTool(opts: ImagineEditToolOptions): Tool {
  const advertised = opts.getSession() === null ? undefined : resolveEditBackend(opts);
  if (advertised !== undefined && !("error" in advertised) && cachedVeniceMediaModels(veniceList(advertised)) === undefined) {
    void loadVeniceMediaModels(veniceList(advertised),
      withToolCallTransport(opts.fetchImpl ?? fetch, advertised.authority)).catch(() => undefined);
  }
  return {
    name: "ImagineEdit",
    description:
      "Edit an image in the workspace from a prompt, or upscale it 2x or 4x, with Venice on this session's key, " +
      "and save the result under the workspace.",
    metadata: {
      family: "media",
      source: "builtin",
      hiddenByDefault: false,
      mutating: true,
      // Found through system.searchTools; never on every request.
      deferred: true,
      fixedWriteTargets: () => [join(opts.workspaceRoot, ".agenc", "imagine")],
      keywords: ["edit image", "inpaint", "upscale", "enhance", "retouch", "image", "photo", "media"],
      preferredProfiles: ["coding", "operator", "general"],
    },
    isReadOnly: false,
    requiresApproval: true,
    concurrencyClass: { kind: "exclusive" },
    timeoutMs: 200_000,
    recoveryCategory: "side-effecting",
    admissionEstimate: (args) => {
      const backend = resolveEditBackend(opts, args);
      const scale = upscaleFactor(args.upscale);
      if ("error" in backend || scale === "invalid") return { maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: null };
      const listed = cachedVeniceMediaModels(veniceList(backend));
      if (listed === undefined) {
        void loadVeniceMediaModels(veniceList(backend),
          withToolCallTransport(opts.fetchImpl ?? fetch, backend.authority)).catch(() => undefined);
      }
      const price = callPrice(listed, stringValue(args.model) ?? DEFAULT_EDIT_MODEL, scale);
      return { maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: price ?? null };
    },
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Workspace path of the PNG, JPEG or WebP image to edit or upscale." },
        prompt: { type: "string", description: "What to change, e.g. \"make the sky a sunrise\" (not used for upscale)." },
        upscale: { type: "integer", enum: [2, 4], description: "Upscale the image by this factor instead of editing it." },
        model: {
          type: "string",
          description:
            `A Venice image edit model id (default ${DEFAULT_EDIT_MODEL}; others include qwen-edit-uncensored, ` +
            "grok-imagine-edit, gpt-image-2-edit, nano-banana-2-edit).",
        },
      },
      required: ["image"],
      additionalProperties: false,
    },
    // The image is read and sent to Venice: the read must pass the same
    // deny, ask and protected-path rules as FileRead. An allowed read still
    // waits for this tool's own approval.
    // The image is checked by the very path the reader opens, literally.
    checkPermissions(input, context) {
      const args = input as Record<string, unknown>;
      const ref = stringValue(args.image);
      if (ref !== undefined) {
        const decision = checkToolPathPermission({
          toolName: "ImagineEdit",
          input: args,
          path: imageReferencePath(opts.workspaceRoot, ref),
          cwd: opts.workspaceRoot,
          context: context.getAppState().toolPermissionContext,
          operationType: "read",
          literal: true,
        });
        if (decision.behavior !== "allow") return decision;
      }
      return { behavior: "passthrough", message: "ImagineEdit sends a workspace image to Venice." };
    },
    // Observed before any approval: the image sent is the one checked.
    observeTargets(args) {
      const ref = stringValue(args.image);
      return ref === undefined ? [] : [observeFileTarget(imageReferencePath(opts.workspaceRoot, ref))];
    },
    execute: async (args) => {
      const signal = args.__abortSignal instanceof AbortSignal ? args.__abortSignal : undefined;
      signal?.throwIfAborted();
      const backend = resolveEditBackend(opts, args);
      if ("error" in backend) return refusal(backend.error);
      const ref = stringValue(args.image);
      if (ref === undefined) return refusal("image is required");
      const scale = upscaleFactor(args.upscale);
      if (scale === "invalid") return refusal("upscale must be 2 or 4");
      const prompt = stringValue(args.prompt);
      if (scale === undefined && prompt === undefined) return refusal("prompt is required to edit an image");
      const model = scale === undefined ? stringValue(args.model) ?? DEFAULT_EDIT_MODEL : UPSCALE_MODEL;
      // The calling session's own proxy, client certificate and CA trust.
      const fetchImpl = withToolCallTransport(opts.fetchImpl ?? fetch, backend.authority);
      const listed = await loadVeniceMediaModels(veniceList(backend), fetchImpl, signal);
      const price = callPrice(listed, model, scale);
      if (price === undefined) {
        const names = listed === undefined
          ? [...OFFLINE_EDIT_PRICES.keys()]
          : [...listed.values()].filter(row => row.type === "inpaint").map(row => row.id);
        return refusal(scale === undefined
          ? `Venice edit model must be a priced edit model in Venice's list: ${names.join(", ")}`
          : "Venice's upscale price could not be read");
      }
      const input = await readWorkspaceImage(
        opts.workspaceRoot,
        ref,
        boundTargetFor(args, imageReferencePath(opts.workspaceRoot, ref)),
      );
      if ("error" in input) return refusal(input.error);
      const timeout = AbortSignal.timeout(190_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const endpoint = scale === undefined ? "/image/edit" : "/image/upscale";
      const body = scale === undefined
        ? { model, prompt, image: input.bytes.toString("base64"), output_format: "png" }
        : { image: input.bytes.toString("base64"), scale };
      try {
        const response = await fetchImpl(`${backend.baseURL}${endpoint}`, {
          method: "POST",
          headers: { authorization: `Bearer ${backend.bearer}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: requestSignal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const message = redactSensitiveAPIText(
            `Venice ${scale === undefined ? "edit" : "upscale"} HTTP ${response.status}${detail ? `: ${detail.slice(0, 1000)}` : ""}`
              .replaceAll(backend.bearer, "[REDACTED]"),
          );
          // A refused request produced nothing.
          return response.status >= 400 && response.status < 500 ? refusal(message) : json({ error: message }, true);
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        const bytes = await readCappedImage(response);
        const detected = imageType(bytes);
        if (detected === undefined) {
          return json({ error: `Venice returned ${contentType || "an unknown type"}, not an image` }, true);
        }
        const outDir = join(opts.workspaceRoot, ".agenc", "imagine");
        await mkdir(outDir, { recursive: true });
        const kind = scale === undefined ? "edit" : `upscale-${scale}x`;
        const path = join(outDir, `imagine-${kind}-${randomUUID()}.${EXTENSIONS[detected]}`);
        await writeFile(path, bytes, { signal: requestSignal });
        // The published price is the charge of record.
        return {
          ...json({
            backend: "venice",
            operation: scale === undefined ? "edit" : "upscale",
            model,
            ...(scale === undefined ? {} : { scale }),
            source: input.path,
            path,
            bytes: bytes.byteLength,
            costUsd: price,
          }),
          admissionUsage: { inputTokens: 0, outputTokens: 0, costUsd: price },
        };
      } catch (error) {
        signal?.throwIfAborted();
        return json({ error: error instanceof Error ? error.message : "Venice image request failed" }, true);
      }
    },
  };
}
