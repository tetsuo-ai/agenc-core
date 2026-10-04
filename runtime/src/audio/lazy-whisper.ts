import { isAbsolute } from "node:path";
import type { WhisperService } from "./whisper.js";

export function createLazyWhisperService(options: {
  home: string;
  env?: NodeJS.ProcessEnv;
}): WhisperService {
  // Keep constructor validation and the host environment snapshot at startup.
  if (!isAbsolute(options.home)) throw new Error("Whisper home must be absolute");
  const captured = { home: options.home, env: { ...(options.env ?? process.env) } };
  let pending: Promise<WhisperService> | undefined;
  const get = () => pending ??= import("./whisper.js").then(
    ({ LocalWhisperService }) => new LocalWhisperService(captured),
  );
  return {
    status: async params => (await get()).status(params),
    install: async (params, signal) => (await get()).install(params, signal),
    transcribe: async (params, signal) => (await get()).transcribe(params, signal),
  };
}
