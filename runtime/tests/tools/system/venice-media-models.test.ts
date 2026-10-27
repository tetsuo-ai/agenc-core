import { describe, expect, it } from "vitest";

import {
  parseVeniceMediaModels,
  veniceDefaultTier,
  veniceEditPrice,
  veniceImagePrice,
  veniceImageTier,
  veniceSpeechFormat,
  veniceSpeechUsdPerCharacter,
  veniceUpscalePrice,
  type VeniceMediaModel,
} from "../../../src/tools/system/venice-media-models.js";

/**
 * Media tools admit any model Venice's live list names and charge the
 * published price. A name the list does not carry is refused before any
 * request (Venice would substitute its default). The tool suites seed a
 * reviewed fixture; they do not lock the parser or the price helpers:
 * offline and unknown types stay out, flat generation wins over a tier
 * table, extra edit images past `included` add the additional price, and
 * a speech model that lists only WAV is asked for WAV.
 */

function model(partial: Partial<VeniceMediaModel> & Pick<VeniceMediaModel, "id" | "type">): VeniceMediaModel {
  return {
    pricing: {},
    constraints: {},
    voices: [],
    formats: [],
    ...partial,
  };
}

describe("parseVeniceMediaModels", () => {
  it("keeps listed media models and drops offline, empty, and unknown types", () => {
    const models = parseVeniceMediaModels({
      data: [
        { id: "  grok-imagine-image  ", type: "image", model_spec: { name: "Grok Image", pricing: { generation: { usd: 0.06 } } } },
        { id: "tts-orpheus", type: "tts", model_spec: { offline: true, voices: ["dan"], supported_formats: ["wav"], default_format: "wav" } },
        { id: "", type: "image", model_spec: {} },
        { id: "acme-chat", type: "text", model_spec: {} },
        { id: "seedance", type: "video", model_spec: { pricing: { quote: { usd: 0.4 } } } },
        "not-a-row",
      ],
    });
    expect(models.map((entry) => entry.id)).toEqual(["grok-imagine-image", "seedance"]);
    expect(models[0]).toMatchObject({ type: "image", name: "Grok Image" });
    expect(parseVeniceMediaModels({ data: "nope" })).toEqual([]);
    expect(parseVeniceMediaModels(null)).toEqual([]);
  });
});

describe("Venice media prices and formats", () => {
  it("picks 1K / 2K / 4K at the published pixel boundaries", () => {
    expect(veniceImageTier(1000, 1600)).toBe("1K");
    expect(veniceImageTier(1000, 1601)).toBe("2K");
    expect(veniceImageTier(1500, 3000)).toBe("2K");
    expect(veniceImageTier(1501, 3000)).toBe("4K");
  });

  it("charges a flat generation price, else the default-quality tier, else the resolution tier", () => {
    expect(veniceImagePrice(model({
      id: "flat", type: "image",
      pricing: { generation: { usd: 0.06 }, resolutions: { "1K": { usd: 9 } } },
    }), "1K")).toBe(0.06);
    expect(veniceImagePrice(model({
      id: "quality", type: "image",
      constraints: { defaultQuality: "high" },
      pricing: {
        quality: { "2K": { high: { usd: 0.27 }, low: { usd: 0.02 } } },
        resolutions: { "2K": { usd: 0.1 } },
      },
    }), "2K")).toBe(0.27);
    expect(veniceImagePrice(model({
      id: "tier", type: "image",
      pricing: { resolutions: { "1K": { usd: 0.04 } } },
    }), "1K")).toBe(0.04);
    expect(veniceImagePrice(model({ id: "none", type: "image" }), "1K")).toBeUndefined();
    expect(veniceImagePrice(model({
      id: "negative", type: "image",
      pricing: { generation: { usd: -1 } },
    }), "1K")).toBeUndefined();
  });

  it("adds the extra-image charge past the ones Venice includes", () => {
    const edit = model({
      id: "grok-imagine-edit", type: "inpaint",
      pricing: {
        inpaint: { usd: 0.03 },
        inputImages: { included: 1, additional: { usd: 0.0023 } },
      },
    });
    expect(veniceEditPrice(edit, "1K", 1)).toBe(0.03);
    expect(veniceEditPrice(edit, "1K", 2)).toBeCloseTo(0.0323, 10);
    expect(veniceEditPrice(edit, "1K", 0)).toBe(0.03);
    expect(veniceUpscalePrice(model({
      id: "upscale", type: "upscale",
      pricing: { upscale: { "2x": { usd: 0.02 }, "4x": { usd: 0.08 } } },
    }), 2)).toBe(0.02);
    expect(veniceUpscalePrice(model({ id: "upscale", type: "upscale" }), 2)).toBeUndefined();
  });

  it("asks for mp3 when offered, else the model's own format, and prices speech per character", () => {
    expect(veniceSpeechFormat(model({ id: "empty", type: "tts" }))).toBe("mp3");
    expect(veniceSpeechFormat(model({
      id: "both", type: "tts", formats: ["wav", "mp3"], defaultFormat: "wav",
    }))).toBe("mp3");
    expect(veniceSpeechFormat(model({
      id: "wav-only", type: "tts", formats: ["wav"], defaultFormat: "wav",
    }))).toBe("wav");
    expect(veniceSpeechFormat(model({
      id: "ogg-only", type: "tts", formats: ["ogg"],
    }))).toBe("ogg");
    expect(veniceSpeechUsdPerCharacter(model({
      id: "tts", type: "tts", pricing: { input: { usd: 62.5 } },
    }))).toBeCloseTo(62.5 / 1_000_000, 12);
    expect(veniceDefaultTier(model({ id: "plain", type: "image" }))).toBe("1K");
    expect(veniceDefaultTier(model({
      id: "2k", type: "image", constraints: { defaultResolution: "2K" },
    }))).toBe("2K");
  });
});
