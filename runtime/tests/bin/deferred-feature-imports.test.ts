import { beforeAll, describe, expect, it, vi } from "vitest";

const evaluations = vi.hoisted(() => ({ qr: 0, manifest: 0, manifestHelpers: 0 }));

vi.mock("qrcode", async (original) => {
  evaluations.qr++;
  return original();
});
vi.mock("../../src/utils/dxt/mcpb.js", async (original) => {
  evaluations.manifest++;
  return original();
});
vi.mock("../../src/utils/dxt/helpers.js", async (original) => {
  evaluations.manifestHelpers++;
  return original();
});

let coldEvaluations: typeof evaluations;
let mcpb: typeof import("../../src/utils/plugins/mcpbHandler.js");

beforeAll(async () => {
  [mcpb] = await Promise.all([
    import("../../src/utils/plugins/mcpbHandler.js"),
    import("../../src/bin/remote-cli.js"),
    import("../../src/remote/service.js"),
    import("../../src/gateway/owner-telegram.js"),
  ]);
  coldEvaluations = { ...evaluations };
}, 30_000);

describe("optional startup feature imports", () => {
  it("loads remote services and plugin configuration without QR encoders or archive schemas", () => {
    expect(coldEvaluations).toEqual({ qr: 0, manifest: 0, manifestHelpers: 0 });
  });

  it("validates ordinary plugin settings without evaluating archive schemas", async () => {
    const schema = {
      name: { type: "string" as const, title: "Name", description: "Display name", required: true },
    };
    expect(await mcpb.validateUserConfig({ name: "sample" }, schema)).toEqual({
      valid: true, errors: [], invalidKeys: [],
    });
    expect(await mcpb.validateUserConfig({}, schema)).toEqual({
      valid: false, errors: ["Name is required but not provided"], invalidKeys: ["name"],
    });
    expect(evaluations).toEqual({ qr: 0, manifest: 0, manifestHelpers: 0 });
  });
});
