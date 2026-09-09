/** Explicit, isolated real-engine check. Never opens a microphone or a daemon. */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalWhisperService } from "../src/audio/whisper.js";

if (process.env.WHISPER_VERIFY_DOWNLOAD !== "1") throw new Error("Set WHISPER_VERIFY_DOWNLOAD=1 to explicitly download the pinned Base model into an isolated test home");
const fixture = process.argv[2];
if (!fixture) throw new Error("Usage: node --import tsx scripts/check-whisper-local.ts /absolute/path/to/jfk.wav");
const home = await mkdtemp(join(tmpdir(), "agenc-whisper-real-"));
const started = performance.now();
const service = new LocalWhisperService({ home });
const signal = AbortSignal.timeout(10 * 60 * 1000);
try {
  console.log(JSON.stringify({ stage: "status", home, status: await service.status({}) }));
  const installed = await service.install({ model: "base" }, signal);
  if (!installed.models.find((model) => model.id === "base")?.installed) throw new Error("Base model was not verified");
  console.log(JSON.stringify({ stage: "installed", elapsedMs: Math.round(performance.now() - started) }));
  const raw = await readFile(resolve(fixture));
  // Convert RIFF fixture chunks to the capture worklet's canonical header;
  // this fixture adapter accepts only the same PCM encoding as production.
  let offset = 12;
  let format: Buffer | undefined;
  let pcm: Buffer | undefined;
  while (offset + 8 <= raw.length) {
    const name = raw.toString("ascii", offset, offset + 4);
    const length = raw.readUInt32LE(offset + 4);
    if (offset + 8 + length > raw.length) throw new Error("Malformed fixture");
    if (name === "fmt ") format = raw.subarray(offset + 8, offset + 8 + length);
    if (name === "data") pcm = raw.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + (length % 2);
  }
  if (!format || !pcm || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16) throw new Error("Fixture must be PCM16 mono 16kHz");
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  format.copy(wav, 20, 0, 16); wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  const result = await service.transcribe({ model: "base", language: "en", audio: { mimeType: "audio/wav", data: wav.toString("base64") } }, signal);
  console.log(JSON.stringify({ stage: "transcribed", elapsedMs: Math.round(performance.now() - started), result }));
  if (!/ask not what your country can do for you/i.test(result.text)) throw new Error("Fixture transcription did not contain the expected JFK phrase");
  wav.fill(0, 44);
  const silence = await service.transcribe({ model: "base", language: "en", audio: { mimeType: "audio/wav", data: wav.toString("base64") } }, signal);
  if (silence.text !== "") throw new Error("Silence must return no text");
  const leftovers = (await readdir(join(home, "whisper"))).filter((name) => name.startsWith("."));
  if (leftovers.length) throw new Error("Audio or download temporary files were not cleaned up");
  console.log(JSON.stringify({ stage: "passed", silence: true, privateAudioCleaned: true }));
} finally {
  await rm(home, { recursive: true, force: true });
  console.log(JSON.stringify({ stage: "isolated-test-home-removed", home }));
}
