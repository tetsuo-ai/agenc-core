import { appendFileSync } from "node:fs";
import { once } from "node:events";
import { XaiMemeFeature } from "../../../src/gateway/meme.ts";
import { XaiVoiceFeature } from "../../../src/gateway/voice.ts";

const [usageFile, effectsFile, kind, limitText, mode, date] = process.argv.slice(2);
const timer = setTimeout(() => process.exit(70), 10_000);
try {
  const ready = once(process.stdin, "data");
  process.stdin.resume();
  process.stdout.write("READY\n");
  await ready;
  process.stdin.pause();
  const Feature = kind === "meme" ? XaiMemeFeature : XaiVoiceFeature;
  const feature = new Feature({
    apiKey: "fake-provider-only",
    usageFile,
    dailyLimit: Number(limitText),
    now: () => Date.parse(date),
    fetchImpl: async () => {
      appendFileSync(effectsFile, JSON.stringify({ kind, pid: process.pid }) + "\n", { mode: 0o600 });
      if (mode === "after_provider") process.exit(17);
      return kind === "meme"
        ? Response.json({ data: [{ url: "https://image.example/fake.png" }] })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    },
  });
  await feature.handle({
    text: `/${kind} test`,
    reply: async () => {
      if (mode === "before_provider") process.exit(17);
      return "reply-id";
    },
  });
  process.stdout.write("DONE\n");
} finally {
  clearTimeout(timer);
}
