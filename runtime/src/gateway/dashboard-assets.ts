import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

export const DASHBOARD_BASE_PATH = "/ui";

interface DashboardRootOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  currentFile?: string;
}

export interface DashboardHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

function directoryHasDashboardIndex(directory: string): boolean {
  return existsSync(resolve(directory, "index.html"));
}

export function resolveDashboardAssetRoot(
  options: DashboardRootOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const currentFile = options.currentFile ?? __filename;

  const override = env.AGENC_DASHBOARD_DIST?.trim();
  const candidates = [
    override ? resolve(override) : null,
    resolve(dirname(currentFile), "..", "dashboard"),
    resolve(cwd, "dist", "dashboard"),
    resolve(cwd, "runtime", "dist", "dashboard"),
  ].filter((value): value is string => typeof value === "string");

  for (const candidate of candidates) {
    if (directoryHasDashboardIndex(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isExtensionlessRoute(relativePath: string): boolean {
  const lastSegment = relativePath.split("/").filter(Boolean).at(-1) ?? "";
  return !lastSegment.includes(".");
}

function normalizeRelativeRequestPath(pathname: string): string | null {
  if (pathname === DASHBOARD_BASE_PATH) {
    return "";
  }
  if (pathname === `${DASHBOARD_BASE_PATH}/`) {
    return "";
  }
  if (!pathname.startsWith(`${DASHBOARD_BASE_PATH}/`)) {
    return null;
  }

  const relativePath = pathname.slice(DASHBOARD_BASE_PATH.length + 1);
  if (relativePath.length === 0) {
    return "";
  }

  const decodedPath = decodeURIComponent(relativePath);
  const normalizedSegments: string[] = [];
  for (const segment of decodedPath.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    normalizedSegments.push(segment);
  }

  return normalizedSegments.join("/");
}

function contentTypeForExtension(extension: string): string {
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function cacheControlForPath(relativePath: string): string {
  if (relativePath === "index.html") {
    return "no-cache";
  }
  if (relativePath.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

export async function resolveDashboardHttpResponse(
  pathname: string,
  options: DashboardRootOptions = {},
): Promise<DashboardHttpResponse | null> {
  if (pathname === DASHBOARD_BASE_PATH) {
    return {
      status: 307,
      headers: {
        location: `${DASHBOARD_BASE_PATH}/`,
      },
    };
  }

  const relativePath = normalizeRelativeRequestPath(pathname);
  if (relativePath === null) {
    return pathname.startsWith(`${DASHBOARD_BASE_PATH}/`)
      ? {
          status: 404,
          headers: {
            "content-type": "application/json",
          },
          body: Buffer.from(JSON.stringify({ error: "Not found" })),
        }
      : null;
  }

  const assetRoot = resolveDashboardAssetRoot(options);
  if (!assetRoot) {
    return {
      status: 503,
      headers: {
        "content-type": "application/json",
      },
      body: Buffer.from(
        JSON.stringify({
          error:
            "Dashboard assets are unavailable; build the web dashboard and sync runtime dashboard assets first.",
        }),
      ),
    };
  }

  const effectiveRelativePath =
    relativePath === "" || isExtensionlessRoute(relativePath)
      ? "index.html"
      : relativePath;
  const filePath = resolve(assetRoot, effectiveRelativePath);
  const assetRootWithSep = assetRoot.endsWith("/") ? assetRoot : `${assetRoot}/`;
  if (filePath !== assetRoot && !filePath.startsWith(assetRootWithSep)) {
    return {
      status: 404,
      headers: {
        "content-type": "application/json",
      },
      body: Buffer.from(JSON.stringify({ error: "Not found" })),
    };
  }
  if (!existsSync(filePath)) {
    return {
      status: 404,
      headers: {
        "content-type": "application/json",
      },
      body: Buffer.from(JSON.stringify({ error: "Not found" })),
    };
  }

  return {
    status: 200,
    headers: {
      "content-type": contentTypeForExtension(extname(filePath)),
      "cache-control": cacheControlForPath(effectiveRelativePath),
    },
    body: await readFile(filePath),
  };
}
