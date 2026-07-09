/**
 * Telegram/WebChat gateway audio route backed by xAI Text to Speech.
 *
 * Audio generation is deliberately explicit (`/voice`, `/audio`, `/song`,
 * `voice:`, `audio:`, `song:`) with a small natural-language affordance for
 * "make a short song for..." and "say ... with a female/male voice". This
 * avoids surprise-spending TTS credits on normal chat turns.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ChannelReplyOptions } from "./types.js";

export interface GatewayVoiceFeature {
  handle(input: {
    readonly text: string;
    reply(text: string, options?: ChannelReplyOptions): Promise<string>;
  }): Promise<boolean>;
}

export interface XaiVoiceFeatureOptions {
  readonly apiKey: string;
  readonly usageFile: string;
  readonly dailyLimit?: number;
  readonly defaultVoice?: string;
  readonly maleVoice?: string;
  readonly femaleVoice?: string;
  readonly language?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface ParsedVoicePrompt {
  readonly text: string;
  readonly voiceId: string;
  readonly song: boolean;
}

interface VoiceUsageState {
  readonly day: string;
  readonly count: number;
}

interface VoiceConfig {
  readonly defaultVoice: string;
  readonly maleVoice: string;
  readonly femaleVoice: string;
}

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  defaultVoice: "eve",
  maleVoice: "leo",
  femaleVoice: "eve",
};

export function parseVoicePrompt(
  text: string,
  config: Partial<VoiceConfig> = {},
): ParsedVoicePrompt | null {
  const voices: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, ...config };
  const trimmed = text.trim();
  const slash = trimmed.match(
    /^\/(voice|audio|song)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i,
  );
  if (slash !== null) {
    const raw = slash[2]?.trim() ?? "";
    return {
      text: raw,
      voiceId: inferVoiceId(raw, voices),
      song: slash[1]?.toLowerCase() === "song",
    };
  }

  const labeled = trimmed.match(/^(voice|audio|song)\s*:\s*([\s\S]+)$/i);
  if (labeled !== null) {
    const raw = labeled[2]?.trim() ?? "";
    return {
      text: raw,
      voiceId: inferVoiceId(raw, voices),
      song: labeled[1]?.toLowerCase() === "song",
    };
  }

  const naturalSong = trimmed.match(
    /^(?:make|create|generate|write|sing)\s+(?:me\s+)?(?:a\s+)?short\s+song\s+(?:for|about)\s+([\s\S]+)$/i,
  );
  if (naturalSong !== null) {
    const topic = normalizeVoiceText(naturalSong[1] ?? "");
    return {
      text: shortSongText(topic),
      voiceId: inferVoiceId(trimmed, voices),
      song: true,
    };
  }

  const prefixVoice = trimmed.match(
    /^(?:say|tell|read|speak)\s+(?:with|in)\s+(?:the\s+)?(?:voice\s+of\s+)?(female|woman|girl|feminine|male|man|guy|masculine|deep)\s+voice?\s*:?\s+([\s\S]+)$/i,
  );
  if (prefixVoice !== null) {
    const voiceHint = prefixVoice[1] ?? "";
    const raw = prefixVoice[2]?.trim() ?? "";
    return {
      text: raw,
      voiceId: inferVoiceId(voiceHint, voices),
      song: false,
    };
  }

  const suffixVoice = trimmed.match(
    /^(?:say|tell|read|speak)\s+([\s\S]+?)\s+(?:with|in)\s+(?:a\s+|the\s+)?(?:voice\s+of\s+)?(female|woman|girl|feminine|male|man|guy|masculine|deep)\s+voice\.?$/i,
  );
  if (suffixVoice !== null) {
    const raw = suffixVoice[1]?.trim() ?? "";
    const voiceHint = suffixVoice[2] ?? "";
    return {
      text: raw,
      voiceId: inferVoiceId(voiceHint, voices),
      song: false,
    };
  }

  return null;
}

function inferVoiceId(text: string, config: VoiceConfig): string {
  const lower = text.toLowerCase();
  if (/\b(female|woman|girl|feminine)\b/u.test(lower)) return config.femaleVoice;
  if (/\b(male|man|guy|masculine|deep)\b/u.test(lower)) return config.maleVoice;
  if (/\b(warm|soft|calm|conversational)\b/u.test(lower)) return "ara";
  if (/\b(professional|clear|crisp)\b/u.test(lower)) return "rex";
  if (/\b(smooth|balanced)\b/u.test(lower)) return "sal";
  return config.defaultVoice;
}

function shortSongText(topic: string): string {
  const clean = topic.length > 0 ? topic : "AgenC";
  return [
    `<singing>A short song for ${clean}.`,
    `${clean}, light the wire, move the work, raise it higher.`,
    `${clean}, onchain tonight, agents earn and settle it right.</singing>`,
  ].join(" ");
}

function normalizeVoiceText(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 1_500);
}

function readUsage(path: string, day: string): VoiceUsageState {
  if (!existsSync(path)) return { day, count: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<VoiceUsageState>;
    if (raw.day === day && typeof raw.count === "number" && raw.count >= 0) {
      return { day, count: Math.floor(raw.count) };
    }
  } catch {
    // Corrupt usage file resets only the soft daily cap, not any xAI-side cap.
  }
  return { day, count: 0 };
}

function writeUsage(path: string, usage: VoiceUsageState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(usage, null, 2)}\n`, { mode: 0o600 });
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class XaiVoiceFeature implements GatewayVoiceFeature {
  readonly #apiKey: string;
  readonly #usageFile: string;
  readonly #dailyLimit: number;
  readonly #defaultVoice: string;
  readonly #maleVoice: string;
  readonly #femaleVoice: string;
  readonly #language: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(options: XaiVoiceFeatureOptions) {
    this.#apiKey = options.apiKey;
    this.#usageFile = options.usageFile;
    this.#dailyLimit = options.dailyLimit ?? 10;
    this.#defaultVoice = options.defaultVoice ?? DEFAULT_VOICE_CONFIG.defaultVoice;
    this.#maleVoice = options.maleVoice ?? DEFAULT_VOICE_CONFIG.maleVoice;
    this.#femaleVoice = options.femaleVoice ?? DEFAULT_VOICE_CONFIG.femaleVoice;
    this.#language = options.language ?? "auto";
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  async handle(input: {
    readonly text: string;
    reply(text: string, options?: ChannelReplyOptions): Promise<string>;
  }): Promise<boolean> {
    const parsed = parseVoicePrompt(input.text, {
      defaultVoice: this.#defaultVoice,
      maleVoice: this.#maleVoice,
      femaleVoice: this.#femaleVoice,
    });
    if (parsed === null) return false;

    const prompt = normalizeVoiceText(parsed.text);
    if (prompt.length === 0) {
      await input.reply("Use `/voice say something`, `/song short idea`, or `voice: your line`.");
      return true;
    }

    const day = today(this.#now());
    const usage = readUsage(this.#usageFile, day);
    if (usage.count >= this.#dailyLimit) {
      await input.reply("Voice cap hit for today. The audio wallet is taking a breather.");
      return true;
    }

    await input.reply("Generating audio. Keep it short, keep it sharp.");
    try {
      const audio = await this.#generate({
        text: parsed.song ? wrapSinging(prompt) : prompt,
        voiceId: parsed.voiceId,
      });
      writeUsage(this.#usageFile, { day, count: usage.count + 1 });
      const title = parsed.song ? "AgenC short song" : "AgenC voice";
      await input.reply(title, {
        audioBytes: audio.bytes,
        audioContentType: audio.contentType,
        audioFileName: parsed.song ? "agenc-song.mp3" : "agenc-voice.mp3",
        audioTitle: title,
        audioPerformer: "AgenC",
        caption: `${title}: ${stripSpeechTags(prompt)}`.slice(0, 1024),
      });
    } catch (error) {
      this.#log(`gateway voice: xAI TTS failed: ${String(error)}`);
      await input.reply("Voice route failed upstream. Try a shorter line.");
    }
    return true;
  }

  async #generate(input: {
    readonly text: string;
    readonly voiceId: string;
  }): Promise<{ readonly bytes: Uint8Array; readonly contentType: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await this.#fetch("https://api.x.ai/v1/tts", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: input.text,
          voice_id: input.voiceId,
          language: this.#language,
          output_format: {
            codec: "mp3",
            sample_rate: 24000,
            bit_rate: 128000,
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(await safeErrorText(res));
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error("xAI TTS returned empty audio");
      }
      return {
        bytes,
        contentType: res.headers.get("content-type") ?? "audio/mpeg",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function wrapSinging(text: string): string {
  return /<sing(?:ing|-song)>/iu.test(text) ? text : `<singing>${text}</singing>`;
}

function stripSpeechTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\[[^\]]+\]/g, "").trim();
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 0 ? text.slice(0, 500) : `xAI TTS HTTP ${res.status}`;
  } catch {
    return `xAI TTS HTTP ${res.status}`;
  }
}
