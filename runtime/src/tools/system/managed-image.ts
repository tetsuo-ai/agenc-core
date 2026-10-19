import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AuthBackend } from "../../auth/backend.js";
import { MANAGED_IMAGE_MODEL, ManagedImageError } from "../../auth/image-generation.js";
import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { validationErrorToolResult } from "../results.js";
import { safeStringify, type ToolResult } from "../types.js";
import { readToolRuntimeContext } from "../runtimes/context.js";

/** UUIDv5 over durable, runtime-authenticated identity; never a model-supplied retry token. */
function imageRequestId(args: Record<string, unknown>): string {
  const context = readToolRuntimeContext(args);
  const sessionId = context?.invocation.session.conversationId;
  const turnId = context?.invocation.turn.subId;
  if (!context || context.toolName !== "ImagineImage" || !sessionId || !turnId || !context.callId) return randomUUID();
  const namespace = Buffer.from("4facbb42bcc84da0bd4fbc6a52fa599d", "hex");
  const digest = createHash("sha1").update(namespace)
    .update(JSON.stringify([sessionId, turnId, context.callId])).digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function generateManagedImage(options: {
  readonly authBackend: AuthBackend | undefined;
  readonly workspaceRoot: string;
  readonly args: Record<string, unknown>;
  readonly signal?: AbortSignal;
}): Promise<ToolResult> {
  const refuse = (error: string) => validationErrorToolResult("tool:ImagineImage:agenc:validation", safeStringify({ error }));
  const { args, authBackend, signal } = options;
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt || prompt.length > 4000) return refuse("Image prompt must contain 1–4000 characters.");
  if ((args.model !== undefined && args.model !== MANAGED_IMAGE_MODEL) ||
      (args.n !== undefined && args.n !== 1) ||
      (args.aspect_ratio !== undefined && !["1:1", "auto"].includes(String(args.aspect_ratio))) ||
      (args.resolution !== undefined && args.resolution !== "1k")) {
    return refuse("Free AgenC images use Qwen Image 2.1, one 1024×1024 image per request. Omit model, n, aspect_ratio and resolution to use these defaults.");
  }
  if (!authBackend?.getImageGenerationAccess || !authBackend.generateImage) return refuse("Sign in with AgenC to check free image generation availability.");
  let submitted = false;
  const requestId = imageRequestId(args);
  try {
    signal?.throwIfAborted();
    const access = await authBackend.getImageGenerationAccess(signal);
    if (!access) return refuse("Sign in with AgenC to use free image generation.");
    if (access.enabled && access.quota.remaining === 0) return refuse("Your daily free image allowance is exhausted. Try again after the quota resets.");
    if (!access.enabled || !access.available) return refuse(access.reason === "image_generation_busy"
      ? "Free AgenC image generation is busy. Try again later."
      : "Free AgenC image generation is temporarily unavailable. Try again later.");
    signal?.throwIfAborted();
    submitted = true;
    const image = await authBackend.generateImage({ prompt, requestId, ...(signal ? { signal } : {}) });
    const directory = join(options.workspaceRoot, ".agenc", "imagine");
    await mkdir(directory, { recursive: true });
    // A reviewed replay can recover the same provider result after a local
    // save or response failure. Use a fresh exclusive artifact path so it
    // never overwrites an existing image or fails solely on an old filename.
    const path = join(directory, `imagine-${randomUUID()}.png`);
    await writeFile(path, image.bytes, { flag: "wx", ...(signal ? { signal } : {}) });
    return {
      content: safeStringify({ backend: "agenc", model: image.model, paths: [path], path, n: 1, priceUsd: 0,
        ...(args.quality !== undefined ? { ignoredControls: ["quality"] } : {}) }),
      admissionUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      effectDisposition: createToolEffectDispositionEvidence({ disposition: "confirmed_committed", evidenceKind: "provider_receipt",
        evidenceRef: `tool:ImagineImage:agenc:${requestId}`, evidenceMaterial: JSON.stringify({ requestId, path, model: image.model, priceUsd: 0 }) }),
    };
  } catch (error) {
    signal?.throwIfAborted();
    const message = error instanceof ManagedImageError ? error.message
      : submitted ? "AgenC image generation or saving failed. The request outcome could not be confirmed; do not automatically retry."
      : "Free AgenC image availability could not be verified. Try again later.";
    if (!submitted || (error instanceof ManagedImageError && error.noEffect)) return refuse(message);
    return { isError: true, content: safeStringify({ error: message, requestId }) };
  }
}
