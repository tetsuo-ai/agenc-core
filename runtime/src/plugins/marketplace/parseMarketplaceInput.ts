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
        const match = /^\/([^/]+\/[^/]+?)(\/|\.git|$)/u.exec(parsed.pathname);
        if (match?.[1]) {
          const gitUrl = urlWithoutFragment.endsWith(".git")
            ? urlWithoutFragment
            : `${urlWithoutFragment}.git`;
          return {
            ok: true,
            source: {
              source: "git",
              url: gitUrl,
              ...(ref !== undefined ? { ref } : {}),
            },
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
