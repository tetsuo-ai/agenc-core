import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_BASE_PATH,
  resolveDashboardAssetRoot,
  resolveDashboardHttpResponse,
} from "./dashboard-assets.js";

const tempRoots: string[] = [];

async function createDashboardFixture() {
  const root = await mkdtemp(join(tmpdir(), "agenc-dashboard-assets-"));
  tempRoots.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><html><body>dashboard</body></html>");
  await writeFile(join(root, "assets", "app.js"), "console.log('ok');");
  await writeFile(join(root, "assets", "logo.svg"), "<svg></svg>");
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dashboard assets", () => {
  it("prefers the explicit dashboard asset override when it contains an index", async () => {
    const root = await createDashboardFixture();
    expect(
      resolveDashboardAssetRoot({
        env: { AGENC_DASHBOARD_DIST: root } as NodeJS.ProcessEnv,
      }),
    ).toBe(root);
  });

  it("redirects /ui to /ui/", async () => {
    const root = await createDashboardFixture();
    const response = await resolveDashboardHttpResponse(DASHBOARD_BASE_PATH, {
      env: { AGENC_DASHBOARD_DIST: root } as NodeJS.ProcessEnv,
    });

    expect(response).toMatchObject({
      status: 307,
      headers: {
        location: `${DASHBOARD_BASE_PATH}/`,
      },
    });
  });

  it("serves index.html for extensionless client routes", async () => {
    const root = await createDashboardFixture();
    const response = await resolveDashboardHttpResponse("/ui/runs/demo", {
      env: { AGENC_DASHBOARD_DIST: root } as NodeJS.ProcessEnv,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers?.["content-type"]).toContain("text/html");
    expect(response?.headers?.["cache-control"]).toBe("no-cache");
    expect(response?.body?.toString("utf8")).toContain("dashboard");
  });

  it("serves asset files without SPA fallback", async () => {
    const root = await createDashboardFixture();
    const response = await resolveDashboardHttpResponse("/ui/assets/app.js", {
      env: { AGENC_DASHBOARD_DIST: root } as NodeJS.ProcessEnv,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers?.["content-type"]).toContain("text/javascript");
    expect(response?.headers?.["cache-control"]).toContain("immutable");
    expect(response?.body?.toString("utf8")).toContain("console.log");
  });

  it("returns 404 for missing asset files instead of index fallback", async () => {
    const root = await createDashboardFixture();
    const response = await resolveDashboardHttpResponse("/ui/assets/missing.js", {
      env: { AGENC_DASHBOARD_DIST: root } as NodeJS.ProcessEnv,
    });

    expect(response?.status).toBe(404);
  });

  it("rejects traversal attempts", async () => {
    const root = await createDashboardFixture();
    const response = await resolveDashboardHttpResponse("/ui/../secrets.txt", {
      env: { AGENC_DASHBOARD_DIST: root } as NodeJS.ProcessEnv,
    });

    expect(response?.status).toBe(404);
  });
});
