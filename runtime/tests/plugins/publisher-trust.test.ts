import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { pluginSignaturePayloadBytes } from "./resolution.js";
import {
  OFFICIAL_PLUGIN_PUBLISHER_KEY_SHA256,
  OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEY,
  pluginPublisherKeyFingerprint,
} from "./publisher-trust.js";

// Known-good llm-checker signature from tetsuo-ai/agenc-plugins at
// d8f43d61b7448dbb59907d7d9bacb6c660642672. Keeping the manifest bytes and
// digest set here makes key rotation an explicit, reviewable test update.
const SIGNED_MANIFEST = Buffer.from(`{
  "name": "llm-checker",
  "version": "0.2.1",
  "description": "Work out which local LLM this machine can run, from measured hardware and a real memory budget.",
  "author": {
    "name": "tetsuo-ai"
  },
  "homepage": "https://agenc.tech",
  "repository": "https://github.com/tetsuo-ai/agenc-plugins",
  "license": "MIT",
  "keywords": [
    "llm",
    "local-models",
    "hardware",
    "vram",
    "ollama",
    "llama.cpp",
    "model-selection"
  ],
  "commands": {
    "pick-model": {
      "source": "./commands/pick-model.md",
      "description": "Recommend an exact local model artifact that fits this machine's memory budget",
      "argumentHint": "[category or model name]",
      "allowedTools": [
        "Bash",
        "Read"
      ]
    },
    "runtime-check": {
      "source": "./commands/runtime-check.md",
      "description": "Show this machine's hardware budget and installed Ollama models",
      "argumentHint": "",
      "allowedTools": [
        "Bash"
      ]
    }
  },
  "skills": [
    "./skills/local-model-fit"
  ],
  "interface": {
    "displayName": "LLM Checker",
    "shortDescription": "Find which local models this machine can actually run.",
    "longDescription": "Reads the real usable-memory budget with the llm-checker CLI, then ranks exact registry artifacts by hardware fit and reports their estimated memory requirement, quantization, runtime and provenance. The score is deterministic fit and suitability, not a public benchmark result. It never downloads a model, starts a server, or changes runtime configuration.",
    "developerName": "tetsuo-ai",
    "category": "developer-tools",
    "capabilities": [
      "hardware-detection",
      "memory-fit-analysis",
      "artifact-aware-recommendations",
      "installed-model-ranking"
    ],
    "websiteUrl": "https://agenc.tech",
    "brandColor": "#f0a93c",
    "logo": "./assets/logo.png",
    "defaultPrompt": [
      "Which local model can my machine run?",
      "What should I run for coding on this GPU?",
      "Will a 14B model fit in my memory budget?",
      "What are my hardware limits for local models?"
    ],
    "screenshots": []
  }
}
`, "utf8");

const SIGNED_FILES = {
  "assets/logo.png": "sha256:044ff5423f891191d2dbe625fe57d76edbc6bde4d326c1f8874a102ab1285585",
  "commands/pick-model.md": "sha256:fd9adbdfd10ea3f02cd4e2621113357d54c3be02eb09afc55e82b6e289080db6",
  "commands/runtime-check.md": "sha256:1f1e1e3c7baf28ba09e7e72807f524cd090503ff85a4add437c7f197be54822f",
  "skills/local-model-fit/SKILL.md": "sha256:7fe5963e32c9c6c2f9d7ef912deb39b998dd2a36190c99982af7ee976e2a561d",
};

const SIGNATURE =
  "Bm7Nu3ioVXWncjJraWg6m77pjJO4q20A5cgaSUsGumt0Owt6rMKO9J2WA4NPDh+0jFpAYzDndqUlkXDxn5+vBg==";

describe("official plugin publisher trust", () => {
  it("matches the audited fingerprint and verifies an official signature", () => {
    expect(
      pluginPublisherKeyFingerprint(OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEY),
    ).toBe(OFFICIAL_PLUGIN_PUBLISHER_KEY_SHA256);

    const publicKey = createPublicKey({
      key: Buffer.from(OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEY, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        pluginSignaturePayloadBytes(SIGNED_MANIFEST, SIGNED_FILES),
        publicKey,
        Buffer.from(SIGNATURE, "base64"),
      ),
    ).toBe(true);
  });
});
