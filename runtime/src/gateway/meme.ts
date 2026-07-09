/**
 * Telegram/WebChat gateway image route backed by xAI image generation.
 *
 * This is deliberately explicit (`/image ...`, `/meme ...`, `image: ...`, or `meme: ...`) so normal agent
 * turns never surprise-spend image credits. It also keeps the image API key
 * server-side and sends only a public generated image URL back to the channel.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface GatewayMemeReplyOptions {
  readonly photoUrl?: string;
  readonly caption?: string;
}

export interface GatewayMemeFeature {
  handle(input: {
    readonly text: string;
    reply(text: string, options?: GatewayMemeReplyOptions): Promise<string>;
  }): Promise<boolean>;
}

export interface XaiMemeFeatureOptions {
  readonly apiKey: string;
  readonly usageFile: string;
  readonly model?: string;
  readonly dailyLimit?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

interface XaiImageGenerationResponse {
  readonly data?: readonly { readonly url?: string }[];
  readonly error?: { readonly message?: string };
}

interface MemeUsageState {
  readonly day: string;
  readonly count: number;
}

export function parseMemePrompt(text: string): string | null {
  const trimmed = text.trim();
  const slash = trimmed.match(
    /^\/(?:meme|image)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]+))?$/i,
  );
  if (slash !== null) return slash[1]?.trim() ?? "";
  const labeled = trimmed.match(/^(?:meme|image)\s*:\s*([\s\S]+)$/i);
  if (labeled !== null) return labeled[1]?.trim() ?? "";
  return null;
}

function readUsage(path: string, day: string): MemeUsageState {
  if (!existsSync(path)) return { day, count: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MemeUsageState>;
    if (raw.day === day && typeof raw.count === "number" && raw.count >= 0) {
      return { day, count: Math.floor(raw.count) };
    }
  } catch {
    // Corrupt usage file resets only the soft daily cap, not any xAI-side cap.
  }
  return { day, count: 0 };
}

function writeUsage(path: string, usage: MemeUsageState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(usage, null, 2)}\n`, { mode: 0o600 });
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function trimPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 600);
}

export class XaiMemeFeature implements GatewayMemeFeature {
  readonly #apiKey: string;
  readonly #usageFile: string;
  readonly #model: string;
  readonly #dailyLimit: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(options: XaiMemeFeatureOptions) {
    this.#apiKey = options.apiKey;
    this.#usageFile = options.usageFile;
    this.#model = options.model ?? "grok-imagine-image";
    this.#dailyLimit = options.dailyLimit ?? 20;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  async handle(input: {
    readonly text: string;
    reply(text: string, options?: GatewayMemeReplyOptions): Promise<string>;
  }): Promise<boolean> {
    const parsed = parseMemePrompt(input.text);
    if (parsed === null) return false;

    const prompt = trimPrompt(parsed);
    if (prompt.length === 0) {
      await input.reply("Use `/image your idea` or `/meme your idea` and give me something to work with.");
      return true;
    }

    const day = today(this.#now());
    const usage = readUsage(this.#usageFile, day);
    if (usage.count >= this.#dailyLimit) {
      await input.reply("Meme cap hit for today. The image wallet is not an infinite buffet.");
      return true;
    }

    await input.reply("Building the image. Keep your tabs on.");
    try {
      const imageUrl = await this.#generate(prompt);
      writeUsage(this.#usageFile, { day, count: usage.count + 1 });
      const caption = `AgenC image: ${prompt}`.slice(0, 1024);
      await input.reply(caption, { photoUrl: imageUrl, caption });
    } catch (error) {
      this.#log(`gateway meme: xAI generation failed: ${String(error)}`);
      await input.reply("Meme forge failed upstream. Try again with a tighter prompt.");
    }
    return true;
  }

  async #generate(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await this.#fetch("https://api.x.ai/v1/images/generations", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.#model,
          n: 1,
          prompt:
            "Create a sharp, shareable meme image for the AgenC community. " +
            "Keep embedded text short, high-contrast, and readable. Prompt: " +
            prompt,
          response_format: "url",
        }),
        signal: controller.signal,
      });
      const json = (await res.json()) as XaiImageGenerationResponse;
      if (!res.ok) {
        throw new Error(json.error?.message ?? `xAI image generation HTTP ${res.status}`);
      }
      const url = json.data?.[0]?.url;
      if (url === undefined || url.length === 0) {
        throw new Error("xAI image generation returned no image URL");
      }
      return url;
    } finally {
      clearTimeout(timeout);
    }
  }
}
