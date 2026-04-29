import { execFile } from "node:child_process";

import type { VoiceInputConfig } from "../config/schema.js";

export interface VoiceInputService {
  transcribeOnce(): Promise<string | null>;
}

export interface CreateVoiceInputServiceOptions {
  readonly config?: VoiceInputConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function splitCommand(command: string): readonly [string, readonly string[]] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  const unquoted = parts.map((part) =>
    part.replace(/^["']|["']$/gu, ""),
  );
  return [unquoted[0] ?? command, unquoted.slice(1)];
}

export function createVoiceInputService(
  options: CreateVoiceInputServiceOptions,
): VoiceInputService | undefined {
  const config = options.config;
  const env = options.env ?? process.env;
  const command = config?.command?.trim() || env.AGENC_VOICE_INPUT_COMMAND;
  if (config?.enabled !== true && !command) return undefined;
  if (!command) return undefined;
  const timeout = config?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  return {
    transcribeOnce: () =>
      new Promise<string | null>((resolve, reject) => {
        const [bin, args] = splitCommand(command);
        const child = execFile(
          bin,
          [...args],
          {
            cwd,
            env,
            timeout,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new Error(
                  stderr.toString().trim() ||
                    error.message ||
                    "voice input command failed",
                ),
              );
              return;
            }
            const transcript = stdout.toString().trim();
            resolve(transcript.length > 0 ? transcript : null);
          },
        );
        child.stdin?.end();
      }),
  };
}
