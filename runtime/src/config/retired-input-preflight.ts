import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type RetiredConfigInputKind =
  | "user-config-json"
  | "user-settings-json"
  | "user-keybindings-json"
  | "gateway-config-json"
  | "project-settings-json"
  | "project-local-settings-json"
  | "project-mcp-json"
  | "managed-settings-json"
  | "managed-settings-drop-in"
  | "managed-mcp-json";

export interface RetiredConfigInputMetadata {
  readonly kind: RetiredConfigInputKind;
  readonly path: string;
}

export interface RetiredConfigInputPreflightOptions {
  readonly homePath: string;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly managedConfigPath: string;
  /** Inspect retired project and ancestor inputs in addition to global inputs. */
  readonly includeProjectInputs?: boolean;
}

export interface RetiredProjectMcpJsonCandidate {
  readonly path: string;
  readonly insideProject: boolean;
}

function pathIsInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Enumerate the exact project/ancestor MCP JSON inputs understood by the
 * explicit migration command. Ordinary loading and migration share this
 * function so neither can silently drift to a different path authority.
 */
export function retiredProjectMcpJsonCandidates(
  projectRoot: string,
  cwd: string,
): readonly RetiredProjectMcpJsonCandidate[] {
  const root = resolve(projectRoot);
  const start = pathIsInside(cwd, root) ? resolve(cwd) : root;
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!directories.includes(root)) directories.push(root);
  return Object.freeze(
    [...new Set(directories)]
      .reverse()
      .map((directory) => Object.freeze({
        path: join(directory, ".mcp.json"),
        insideProject: pathIsInside(directory, root),
      })),
  );
}

async function pathExistsAsMetadata(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Inspect only names and filesystem metadata for retired configuration
 * inputs. This function never opens, parses, rewrites, archives, or deletes
 * their contents; only the explicit migration command may do that.
 */
export async function detectRetiredConfigInputs(
  options: RetiredConfigInputPreflightOptions,
): Promise<readonly RetiredConfigInputMetadata[]> {
  const homePath = resolve(options.homePath);
  const projectRoot = resolve(options.projectRoot);
  const managedDirectory = dirname(resolve(options.managedConfigPath));
  const exactCandidates: RetiredConfigInputMetadata[] = [
    { kind: "user-config-json", path: join(homePath, "config.json") },
    { kind: "user-settings-json", path: join(homePath, "settings.json") },
    {
      kind: "user-keybindings-json",
      path: join(homePath, "keybindings.json"),
    },
    {
      kind: "gateway-config-json",
      path: join(homePath, "gateway", "config.json"),
    },
    {
      kind: "managed-settings-json",
      path: join(managedDirectory, "managed-settings.json"),
    },
    {
      kind: "managed-mcp-json",
      path: join(managedDirectory, "managed-mcp.json"),
    },
    ...(options.includeProjectInputs === false
      ? []
      : [
          {
            kind: "project-settings-json" as const,
            path: join(projectRoot, ".agenc", "settings.json"),
          },
          {
            kind: "project-local-settings-json" as const,
            path: join(projectRoot, ".agenc", "settings.local.json"),
          },
          ...retiredProjectMcpJsonCandidates(projectRoot, options.cwd).map(
            ({ path }) => ({ kind: "project-mcp-json" as const, path }),
          ),
        ]),
  ];

  const found: RetiredConfigInputMetadata[] = [];
  for (const candidate of exactCandidates) {
    if (await pathExistsAsMetadata(candidate.path)) {
      found.push(Object.freeze({
        ...candidate,
        path: resolve(candidate.path).normalize("NFC"),
      }));
    }
  }

  const managedSettingsDropInDirectory = join(
    managedDirectory,
    "managed-settings.d",
  );
  try {
    const entries = await readdir(managedSettingsDropInDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        !entry.name.endsWith(".json") ||
        (!entry.isFile() && !entry.isSymbolicLink())
      ) {
        continue;
      }
      found.push(Object.freeze({
        kind: "managed-settings-drop-in",
        path: resolve(managedSettingsDropInDirectory, entry.name).normalize(
          "NFC",
        ),
      }));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return Object.freeze(found.sort((left, right) =>
    `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`)
  ));
}
