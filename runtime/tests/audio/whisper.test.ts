import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWhisperService, MAX_WHISPER_WAV_BYTES, runWhisperProcess, validateWhisperAudio, WHISPER_MODELS, WHISPER_LANGUAGES, whisperOptionsArgs } from "../../src/audio/whisper.js";

const homes: string[] = [];
async function home(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "agenc-whisper-unit-")); homes.push(value); return value; }
function wav(samples = 1600): Buffer {
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF"); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(samples * 2, 40);
  return out;
}
function params(audio = wav()): Record<string, unknown> { return { model: "base", language: "auto", audio: { mimeType: "audio/wav", data: audio.toString("base64") } }; }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(homes.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("Whisper bounded audio contract", () => {
  it("accepts only canonical mono PCM16 16kHz including the maximum 30 seconds", () => {
    expect(validateWhisperAudio(params()).wav.length).toBe(3244);
    expect(validateWhisperAudio(params(wav(480000))).wav.length).toBe(MAX_WHISPER_WAV_BYTES);
  });
  it.each([0, 4, 8, 16, 20, 22, 24, 28, 32, 34, 36, 40])("rejects a corrupt header field at %s", (offset) => {
    const audio = wav(); audio[offset] ^= 1;
    expect(() => validateWhisperAudio(params(audio))).toThrow();
  });
  it("rejects empty and oversized audio before native decoding", () => {
    expect(() => validateWhisperAudio(params(wav(0)))).toThrow();
    expect(() => validateWhisperAudio(params(wav(480001)))).toThrow();
  });
  it.each(["..", "tiny", "base.en", "https://bad.invalid/a", "-f", null])("rejects non-allowlisted model %s", (model) => {
    expect(() => validateWhisperAudio({ ...params(), model })).toThrow();
  });
  it.each(["unknown", "--translate", "en-US", "EN", "yue", null])("rejects invalid language %s", (language) => expect(() => validateWhisperAudio({ ...params(), language })).toThrow());
  it.each(WHISPER_LANGUAGES)("accepts allowlisted input language %s", (language) => {
    expect(validateWhisperAudio({ ...params(), language }).language).toBe(language);
  });
  it("preserves original behavior when all new options are omitted", () => {
    const validated = validateWhisperAudio(params());
    expect(validated).toMatchObject({ task: "transcribe", compute: "auto", prompt: "" });
    expect(whisperOptionsArgs(validated)).toEqual([]);
  });
  it("translates only to English and bounds CPU selection to the no-GPU switch", () => {
    const validated = validateWhisperAudio({ ...params(), language: "es", task: "translate", compute: "cpu", prompt: "  AgenC, whisper.cpp  " });
    expect(validated).toMatchObject({ language: "es", task: "translate", compute: "cpu", prompt: "AgenC, whisper.cpp" });
    expect(whisperOptionsArgs(validated)).toEqual(["-tr", "-ng", "--prompt", "AgenC, whisper.cpp"]);
  });
  it.each(["translate-to-es", "-tr", true, null])("rejects invalid task %s", (task) => expect(() => validateWhisperAudio({ ...params(), task })).toThrow());
  it.each(["gpu", "-ng", true, null])("rejects invalid compute %s", (compute) => expect(() => validateWhisperAudio({ ...params(), compute })).toThrow());
  it("validates prompt length in JavaScript characters and trims surrounding whitespace", () => {
    expect(validateWhisperAudio({ ...params(), prompt: "x".repeat(500) }).prompt).toHaveLength(500);
    expect(validateWhisperAudio({ ...params(), prompt: "😀".repeat(250) }).prompt).toHaveLength(500);
    expect(() => validateWhisperAudio({ ...params(), prompt: "😀".repeat(251) })).toThrow();
    expect(() => validateWhisperAudio({ ...params(), prompt: "x".repeat(501) })).toThrow();
    expect(whisperOptionsArgs(validateWhisperAudio({ ...params(), prompt: "    " }))).toEqual([]);
  });
  it.each([...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)), "\u007f"])("rejects a control character in the vocabulary", (control) => {
    expect(() => validateWhisperAudio({ ...params(), prompt: `AgenC${control}voice` })).toThrow();
  });
  it.each([false, 1, null, {}, []])("rejects non-string vocabulary", (prompt) => expect(() => validateWhisperAudio({ ...params(), prompt })).toThrow());
  it("keeps CLI-looking, quoted, and shell-looking vocabulary in one literal argument", () => {
    const prompt = '--language fr; $(touch secret) "quoted"';
    expect(whisperOptionsArgs(validateWhisperAudio({ ...params(), prompt }))).toEqual(["--prompt", prompt]);
  });
  it("rejects MIME confusion, extra keys, and noncanonical base64", () => {
    expect(() => validateWhisperAudio({ ...params(), path: "/etc/passwd" })).toThrow();
    for (const data of ["!".repeat(44), "A===", "YWJ=", "YQ", ` ${wav().toString("base64")}`]) {
      expect(() => validateWhisperAudio({ ...params(), audio: { mimeType: "audio/wav", data } })).toThrow();
    }
    expect(() => validateWhisperAudio({ ...params(), audio: { mimeType: "audio/mp3", data: wav().toString("base64") } })).toThrow();
  });
});

describe("Whisper installation boundary", () => {
  it("verifies download contents, removes partial files, and uses only a pinned URL", async () => {
    const root = await home(); const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))); vi.stubGlobal("fetch", fetch);
    const service = new LocalWhisperService({ home: root, env: { AGENC_WHISPER_CLI: process.execPath } });
    await expect(service.install({ model: "base" }, new AbortController().signal)).rejects.toMatchObject({ code: "WHISPER_MODEL_INTEGRITY" });
    expect(fetch).toHaveBeenCalledWith("https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin", expect.objectContaining({ credentials: "omit" }));
    expect(await readdir(join(root, "whisper"))).toEqual([]);
  });
  it("bounds work, propagates download cancellation, and admits work again afterward", async () => {
    const root = await home(); const controller = new AbortController();
    const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    vi.stubGlobal("fetch", fetch);
    const service = new LocalWhisperService({ home: root, env: { AGENC_WHISPER_CLI: process.execPath } });
    const first = service.install({ model: "base" }, controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(service.install({ model: "small" }, new AbortController().signal)).rejects.toMatchObject({ code: "WHISPER_BUSY" });
    await expect(service.transcribe(params(), new AbortController().signal)).rejects.toMatchObject({ code: "WHISPER_BUSY" });
    controller.abort(); await rejected;
    expect(await readdir(join(root, "whisper"))).toEqual([]);
    await expect(service.transcribe(params(), new AbortController().signal)).rejects.toMatchObject({ code: "WHISPER_MODEL_UNAVAILABLE" });
  });
  it("status never downloads, creates directories, or trusts arbitrary PATH", async () => {
    const root = await home(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const service = new LocalWhisperService({ home: root, env: { AGENC_WHISPER_CLI: "relative/whisper-cli", PATH: "/malicious" } });
    const status = await service.status({});
    expect(status.available).toBe(false);
    expect(status.optionsVersion).toBe(1);
    expect(status.models).toEqual([{ id: "base", installed: false, bytes: WHISPER_MODELS.base.bytes }, { id: "small", installed: false, bytes: WHISPER_MODELS.small.bytes }]);
    expect(fetch).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });
  it("rejects extra status and install parameters", async () => {
    const service = new LocalWhisperService({ home: await home(), env: {} });
    await expect(service.status({ url: "https://bad.invalid" })).rejects.toThrow();
    await expect(service.install({ model: "base", path: "/tmp/other" }, new AbortController().signal)).rejects.toThrow();
  });
  it("rejects a symlinked storage directory", async () => {
    const root = await home(); const elsewhere = await home(); await symlink(elsewhere, join(root, "whisper"));
    await expect(new LocalWhisperService({ home: root }).status({})).rejects.toMatchObject({ code: "WHISPER_STORAGE_UNSAFE" });
  });
  it("does not mark truncated or symlinked models installed", async () => {
    const root = await home(); await mkdir(join(root, "whisper"), { mode: 0o700 });
    await writeFile(join(root, "whisper", "ggml-base.bin"), "bad", { mode: 0o600 });
    await symlink(join(root, "whisper", "ggml-base.bin"), join(root, "whisper", "ggml-small.bin"));
    expect((await new LocalWhisperService({ home: root }).status({})).models.every((model) => !model.installed)).toBe(true);
  });
  it("cancels before touching disk or downloading", async () => {
    const root = await home(); const controller = new AbortController(); controller.abort();
    const service = new LocalWhisperService({ home: root });
    await expect(service.install({ model: "base" }, controller.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(service.transcribe(params(), controller.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(await readdir(root)).toEqual([]);
  });
});

describe("Whisper native process boundary", () => {
  it("strips credential/loader environment and separates stderr from transcript", async () => {
    const text = await runWhisperProcess(process.execPath, ["-e", "process.stderr.write('private diagnostic');process.stdout.write(JSON.stringify({key:process.env.OPENAI_API_KEY,loader:process.env.NODE_OPTIONS,lang:process.env.LANG}))"], await home(), { OPENAI_API_KEY: "must-not-leak", NODE_OPTIONS: "--invalid" }, new AbortController().signal);
    expect(JSON.parse(text)).toEqual({ lang: "en_US.UTF-8" });
  });
  it("bounds combined process output without exposing diagnostic contents", async () => {
    await expect(runWhisperProcess(process.execPath, ["-e", "process.stderr.write('s'.repeat(70000));setInterval(()=>{},1000)"], await home(), {}, new AbortController().signal)).rejects.toMatchObject({ code: "WHISPER_OUTPUT_LIMIT" });
  });
  it("aborts a running native child", async () => {
    const controller = new AbortController();
    const running = runWhisperProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], await home(), {}, controller.signal);
    const expectation = expect(running).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    controller.abort(); await expectation;
  });
  it("sanitizes native spawn and exit errors", async () => {
    const root = await home();
    await expect(runWhisperProcess(join(root, "missing"), [], root, {}, new AbortController().signal)).rejects.toMatchObject({ code: "WHISPER_ENGINE_FAILED", message: "Could not run the Whisper engine" });
    await expect(runWhisperProcess(process.execPath, ["-e", "process.stderr.write('private path');process.exit(2)"], root, {}, new AbortController().signal)).rejects.toMatchObject({ code: "WHISPER_ENGINE_FAILED", message: "Whisper could not transcribe this phrase" });
  });
});
