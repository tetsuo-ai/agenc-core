import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { JsonObject } from "../app-server/protocol/index.js";

export type WhisperModel = "base" | "small";
export const WHISPER_LANGUAGES = ["auto", "en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "uk", "zh", "ja", "ko", "ar", "hi", "tr"] as const;
export type WhisperLanguage = (typeof WHISPER_LANGUAGES)[number];
export type WhisperTask = "transcribe" | "translate";
export type WhisperCompute = "auto" | "cpu";
export const MAX_WHISPER_PROMPT_CHARS = 500;
export interface WhisperStatus extends JsonObject {
  readonly engine: "whisper.cpp";
  /** Optional on older daemons; version 1 enables task, compute, and prompt. */
  readonly optionsVersion?: 1;
  readonly available: boolean;
  readonly reason?: string;
  readonly models: readonly { readonly id: WhisperModel; readonly installed: boolean; readonly bytes: number }[];
}
export interface WhisperTranscription extends JsonObject {
  readonly text: string;
  readonly model: string;
  readonly provider: "local";
}
export interface WhisperInstallParams { readonly model: WhisperModel }
export interface WhisperTranscribeParams extends WhisperInstallParams {
  readonly audio: { readonly data: string; readonly mimeType: "audio/wav" };
  readonly language: WhisperLanguage;
  readonly task?: WhisperTask;
  readonly compute?: WhisperCompute;
  readonly prompt?: string;
}
export interface WhisperService {
  status(params: unknown): Promise<WhisperStatus>;
  install(params: unknown, signal: AbortSignal): Promise<WhisperStatus>;
  transcribe(params: unknown, signal: AbortSignal): Promise<WhisperTranscription>;
}

// Upstream ggml conversion repository, pinned September 8, 2026. Both models
// are multilingual. LFS SHA256 and byte lengths verified against the revision.
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
export const WHISPER_MODELS = {
  base: { bytes: 147951465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
  small: { bytes: 487601967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
} as const;
export const MAX_WHISPER_WAV_BYTES = 44 + 16000 * 2 * 30;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_CHARS = 16000;

export class WhisperError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WhisperError"; }
}
function invalid(message: string): never { throw new WhisperError("WHISPER_INVALID_ARGUMENT", message); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid("Unexpected Whisper parameter");
  return record;
}
function modelParam(params: unknown): WhisperModel {
  const { model } = object(params, ["model"]);
  if (model !== "base" && model !== "small") invalid("Choose Base or Small");
  return model;
}
interface ValidatedWhisperOptions {
  readonly task: WhisperTask;
  readonly compute: WhisperCompute;
  readonly prompt: string;
}
export function validateWhisperAudio(params: unknown): ValidatedWhisperOptions & { model: WhisperModel; language: WhisperLanguage; wav: Buffer } {
  const input = object(params, ["audio", "model", "language", "task", "compute", "prompt"]);
  const model = modelParam({ model: input.model });
  const language = input.language;
  if (typeof language !== "string" || !(WHISPER_LANGUAGES as readonly string[]).includes(language)) invalid("Unsupported Whisper language");
  const task = input.task === undefined ? "transcribe" : input.task;
  if (task !== "transcribe" && task !== "translate") invalid("Unsupported Whisper task");
  const compute = input.compute === undefined ? "auto" : input.compute;
  if (compute !== "auto" && compute !== "cpu") invalid("Unsupported Whisper compute mode");
  const rawPrompt = input.prompt === undefined ? "" : input.prompt;
  if (typeof rawPrompt !== "string" || rawPrompt.length > MAX_WHISPER_PROMPT_CHARS || /[\u0000-\u001f\u007f]/u.test(rawPrompt)) invalid("Vocabulary must be at most 500 characters and contain no control characters");
  const prompt = rawPrompt.trim();
  const audio = object(input.audio, ["data", "mimeType"]);
  if (audio.mimeType !== "audio/wav" || typeof audio.data !== "string") invalid("Expected WAV audio");
  const encoded = audio.data;
  if (encoded.length > Math.ceil(MAX_WHISPER_WAV_BYTES / 3) * 4 || encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid("Invalid audio encoding or length");
  const wav = Buffer.from(encoded, "base64");
  if (wav.length <= 44 || wav.length > MAX_WHISPER_WAV_BYTES || wav.toString("base64") !== encoded) invalid("Invalid audio length");
  // The capture worklet emits this canonical header. Reject arbitrary RIFF
  // chunks/codecs rather than exposing the native parser to uploaded formats.
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.readUInt32LE(4) !== wav.length - 8 ||
      wav.toString("ascii", 8, 16) !== "WAVEfmt " || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 ||
      wav.readUInt32LE(28) !== 32000 || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 ||
      wav.toString("ascii", 36, 40) !== "data" || wav.readUInt32LE(40) !== wav.length - 44 || (wav.length - 44) % 2 !== 0) invalid("Audio must be PCM16 mono 16 kHz WAV, at most 30 seconds");
  return { model, language: language as WhisperLanguage, task, compute, prompt, wav };
}
/** Translate means English output only. Every value remains one argv element. */
export function whisperOptionsArgs(options: ValidatedWhisperOptions): string[] {
  return [
    ...(options.task === "translate" ? ["-tr"] : []),
    ...(options.compute === "cpu" ? ["-ng"] : []),
    ...(options.prompt ? ["--prompt", options.prompt] : []),
  ];
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new WhisperError("REQUEST_CANCELLED", "Whisper request cancelled");
}

export class LocalWhisperService implements WhisperService {
  readonly #root: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #verified = new Map<WhisperModel, string>();
  #transcribing = false;
  #installing = false;
  constructor(options: { home: string; env?: NodeJS.ProcessEnv }) {
    if (!isAbsolute(options.home)) throw new Error("Whisper home must be absolute");
    this.#root = join(options.home, "whisper");
    this.#env = { ...(options.env ?? process.env) };
  }
  async #executable(): Promise<string | undefined> {
    const configured = this.#env.AGENC_WHISPER_CLI;
    // Host startup environment only, never a client environment snapshot or PATH.
    const candidates = configured ? [configured] : process.platform === "darwin"
      ? ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
      : ["/usr/local/bin/whisper-cli", "/usr/bin/whisper-cli"];
    for (const candidate of candidates) {
      if (!isAbsolute(candidate)) continue;
      try {
        const resolved = await realpath(candidate);
        const stat = await lstat(resolved);
        if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) continue;
        await access(resolved, constants.X_OK);
        return resolved;
      } catch { /* unavailable executable */ }
    }
    return undefined;
  }
  async #directory(create: boolean): Promise<boolean> {
    if (create) await mkdir(this.#root, { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(this.#root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
        throw new WhisperError("WHISPER_STORAGE_UNSAFE", "Whisper storage must be a private directory");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return false;
      throw error;
    }
  }
  #modelPath(model: WhisperModel): string { return join(this.#root, `ggml-${model}.bin`); }
  async #installed(model: WhisperModel, signal?: AbortSignal): Promise<boolean> {
    if (!await this.#directory(false)) return false;
    let file;
    try { file = await open(this.#modelPath(model), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== WHISPER_MODELS[model].bytes || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return false;
      const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (this.#verified.get(model) === identity) return true;
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(1024 * 1024);
      for (;;) {
        if (signal) cancelled(signal);
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        hash.update(chunk.subarray(0, bytesRead));
      }
      if (hash.digest("hex") !== WHISPER_MODELS[model].sha256) return false;
      this.#verified.set(model, identity);
      return true;
    } finally { await file.close(); }
  }
  async status(params: unknown): Promise<WhisperStatus> {
    object(params, []);
    try {
      const available = Boolean(await this.#executable());
      const models = await Promise.all((Object.keys(WHISPER_MODELS) as WhisperModel[]).map(async (id) => ({ id, bytes: WHISPER_MODELS[id].bytes, installed: await this.#installed(id) })));
      return { engine: "whisper.cpp", optionsVersion: 1, available, ...(available ? {} : { reason: "Install whisper.cpp on this computer, or configure AGENC_WHISPER_CLI on the host." }), models };
    } catch (error) {
      if (error instanceof WhisperError) throw error;
      throw new WhisperError("WHISPER_STORAGE_UNAVAILABLE", "Could not read private Whisper storage");
    }
  }
  async install(params: unknown, signal: AbortSignal): Promise<WhisperStatus> {
    const model = modelParam(params);
    cancelled(signal);
    if (this.#installing || this.#transcribing) throw new WhisperError("WHISPER_BUSY", "Whisper is busy. Try again when it finishes.");
    this.#installing = true;
    let partial: string | undefined;
    try {
      if (!await this.#executable()) throw new WhisperError("WHISPER_ENGINE_UNAVAILABLE", "Install whisper.cpp before downloading a model");
      if (await this.#installed(model, signal)) return await this.status({});
      await this.#directory(true);
      partial = join(this.#root, `.download-${randomUUID()}.partial`);
      const deadline = AbortSignal.timeout(10 * 60 * 1000);
      const combined = AbortSignal.any([signal, deadline]);
      const manifest = WHISPER_MODELS[model];
      const response = await fetch(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/ggml-${model}.bin`, { signal: combined, credentials: "omit", redirect: "follow" });
      if (!response.ok || !response.body) throw new WhisperError("WHISPER_DOWNLOAD_FAILED", "Could not download the Whisper model");
      const file = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          cancelled(combined);
          bytes += chunk.length;
          if (bytes > manifest.bytes) throw new WhisperError("WHISPER_MODEL_INTEGRITY", "Whisper model is larger than expected");
          hash.update(chunk);
          await file.writeFile(chunk);
        }
        if (bytes !== manifest.bytes || hash.digest("hex") !== manifest.sha256) throw new WhisperError("WHISPER_MODEL_INTEGRITY", "Whisper model verification failed");
        cancelled(combined);
        await file.sync();
      } finally { await file.close(); }
      await rename(partial, this.#modelPath(model));
      partial = undefined;
      this.#verified.delete(model);
      return await this.status({});
    } catch (error) {
      cancelled(signal);
      if (error instanceof WhisperError) throw error;
      throw new WhisperError("WHISPER_DOWNLOAD_FAILED", "Whisper model download failed or timed out. Try again.");
    } finally {
      try { if (partial) await rm(partial, { force: true }); }
      catch { throw new WhisperError("WHISPER_STORAGE_UNAVAILABLE", "Could not remove an incomplete Whisper download"); }
      finally { this.#installing = false; }
    }
  }
  async transcribe(params: unknown, signal: AbortSignal): Promise<WhisperTranscription> {
    const { model, language, task, compute, prompt, wav } = validateWhisperAudio(params);
    cancelled(signal);
    if (this.#transcribing || this.#installing) throw new WhisperError("WHISPER_BUSY", "Whisper is busy. Try again when it finishes.");
    this.#transcribing = true;
    let temp: string | undefined;
    try {
      const executable = await this.#executable();
      if (!executable) throw new WhisperError("WHISPER_ENGINE_UNAVAILABLE", "Whisper engine is not installed on this computer");
      if (!await this.#installed(model, signal)) throw new WhisperError("WHISPER_MODEL_UNAVAILABLE", "Download this Whisper model in Settings first");
      cancelled(signal);
      // Exact zero / near-zero input never reaches a hallucination-prone decoder.
      let peak = 0;
      for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
      if (peak < 32) return { text: "", model, provider: "local" };
      temp = await mkdtemp(join(this.#root, ".audio-"));
      const audioPath = join(temp, "speech.wav");
      const audioFile = await open(audioPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await audioFile.writeFile(wav); } finally { await audioFile.close(); }
      const text = await runWhisperProcess(executable, ["-m", this.#modelPath(model), "-f", audioPath, "-l", language, "-np", "-nt", "-nf", "-t", "4", ...whisperOptionsArgs({ task, compute, prompt })], temp, this.#env, signal);
      return { text: text.trim(), model, provider: "local" };
    } catch (error) {
      cancelled(signal);
      if (error instanceof WhisperError) throw error;
      throw new WhisperError("WHISPER_ENGINE_FAILED", "Whisper could not transcribe this phrase");
    } finally {
      wav.fill(0);
      try { if (temp) await rm(temp, { recursive: true, force: true }); }
      catch { throw new WhisperError("WHISPER_STORAGE_UNAVAILABLE", "Could not remove temporary Whisper audio"); }
      finally { this.#transcribing = false; }
    }
  }
}

/** Internal process boundary; executable/args are constructed by the host service, never RPC params. */
export function runWhisperProcess(executable: string, args: string[], cwd: string, hostEnv: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    // Do not pass LLM credentials, proxy credentials, NODE_OPTIONS, or dynamic
    // loader overrides into the speech process. No shell, stdin or network API.
    const env: NodeJS.ProcessEnv = { LANG: "en_US.UTF-8" };
    for (const key of ["HOME", "TMPDIR", "SystemRoot", "WINDIR"]) if (hostEnv[key]) env[key] = hostEnv[key];
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const decoder = new StringDecoder("utf8");
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error): void => {
      failure ??= error;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1500);
      killTimer.unref();
    };
    const abort = (): void => stop(new WhisperError("REQUEST_CANCELLED", "Whisper request cancelled"));
    const timer = setTimeout(() => stop(new WhisperError("WHISPER_TIMEOUT", "Whisper took too long to transcribe this phrase")), 90_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const collect = (chunk: Buffer, transcript: boolean): void => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { stop(new WhisperError("WHISPER_OUTPUT_LIMIT", "Whisper output exceeded its limit")); return; }
      if (transcript) output += decoder.write(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => { failure ??= new WhisperError("WHISPER_ENGINE_FAILED", "Could not run the Whisper engine"); });
    child.on("close", (code) => {
      output += decoder.end();
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new WhisperError("WHISPER_ENGINE_FAILED", "Whisper could not transcribe this phrase"));
      else if (output.length > MAX_TRANSCRIPT_CHARS) reject(new WhisperError("WHISPER_OUTPUT_LIMIT", "Whisper transcript exceeded its limit"));
      else resolve(output);
    });
  });
}
