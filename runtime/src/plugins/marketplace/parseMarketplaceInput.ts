import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { MarketplaceSource } from "./marketplace.js";

export type ParsedMarketplaceInput =
  | { readonly ok: true; readonly source: MarketplaceSource }
  | { readonly ok: false; readonly error: string }
  | { readonly ok: false; readonly unrecognized: true };

export async function parseMarketplaceInput(
  input: string,
): Promise<ParsedMarketplaceInput> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, unrecognized: true };
  }

  const sshMatch = /^([a-zA-Z0-9._-]+@[^:]+:.+?(?:\.git)?)(#(.+))?$/u.exec(trimmed);
  if (sshMatch?.[1]) {
    return {
      ok: true,
      source: {
        source: "git",
        url: sshMatch[1],
        ...(sshMatch[3] !== undefined ? { ref: sshMatch[3] } : {}),
      },
    };
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const fragmentMatch = /^([^#]+)(#(.+))?$/u.exec(trimmed);
    const urlWithoutFragment = fragmentMatch?.[1] ?? trimmed;
    const ref = fragmentMatch?.[3];
    if (urlWithoutFragment.endsWith(".git") || urlWithoutFragment.includes("/_git/")) {
      return {
        ok: true,
        source: {
          source: "git",
          url: urlWithoutFragment,
          ...(ref !== undefined ? { ref } : {}),
        },
      };
    }
    try {
      const parsed = new URL(urlWithoutFragment);
      if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
        const source = parseGitHubUrl(parsed, ref);
        if (source !== null) {
          return {
            ok: true,
            source,
          };
        }
      }
      return { ok: true, source: { source: "url", url: urlWithoutFragment } };
    } catch {
      return { ok: true, source: { source: "url", url: urlWithoutFragment } };
    }
  }

  const local = await parseLocalPath(trimmed);
  if (local !== null) return local;

  if (trimmed.includes("/") && !trimmed.startsWith("@") && !trimmed.includes(":")) {
    const fragmentMatch = /^([^#@]+)(?:[#@](.+))?$/u.exec(trimmed);
    const repo = fragmentMatch?.[1] ?? trimmed;
    const ref = fragmentMatch?.[2];
    return {
      ok: true,
      source: {
        source: "github",
        repo,
        ...(ref !== undefined ? { ref } : {}),
      },
    };
  }

  return { ok: false, unrecognized: true };
}

function parseGitHubUrl(parsed: URL, fragmentRef: string | undefined): MarketplaceSource | null {
  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  const owner = parts[0];
  const repoPart = parts[1];
  if (owner === undefined || repoPart === undefined) return null;
  const repo = `${owner}/${repoPart.replace(/\.git$/u, "")}`;
  if (!repo.includes("/") || repo.endsWith("/")) return null;
  if (parts.length >= 4 && (parts[2] === "tree" || parts[2] === "blob")) {
    return {
      source: "github",
      repo,
      ref: parts[3],
      ...(parts.length > 4 ? { path: parts.slice(4).join("/") } : {}),
    };
  }
  return {
    source: "github",
    repo,
    ...(fragmentRef !== undefined ? { ref: fragmentRef } : {}),
  };
}

async function parseLocalPath(value: string): Promise<ParsedMarketplaceInput | null> {
  const isWindows = process.platform === "win32";
  const isWindowsPath = isWindows &&
    (value.startsWith(".\\") || value.startsWith("..\\") || /^[a-zA-Z]:[/\\]/u.test(value));
  if (
    !value.startsWith("./") &&
    !value.startsWith("../") &&
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !isWindowsPath
  ) {
    return null;
  }
  const resolvedPath = resolve(value.startsWith("~") ? value.replace(/^~/u, homedir()) : value);
  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch (error) {
    const code = errno(error);
    return {
      ok: false,
      error: code === "ENOENT"
        ? `Path does not exist: ${resolvedPath}`
        : `Cannot access path: ${resolvedPath} (${code ?? String(error)})`,
    };
  }
  if (stats.isFile()) {
    if (resolvedPath.endsWith(".json")) {
      return { ok: true, source: { source: "file", path: resolvedPath } };
    }
    return {
      ok: false,
      error: `File path must point to a .json file (marketplace.json), but got: ${resolvedPath}`,
    };
  }
  if (stats.isDirectory()) {
    return { ok: true, source: { source: "directory", path: resolvedPath } };
  }
  return {
    ok: false,
    error: `Path is neither a file nor a directory: ${resolvedPath}`,
  };
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}
