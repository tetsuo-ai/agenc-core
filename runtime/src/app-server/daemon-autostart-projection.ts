/** Import-only speculation hint, never configuration or admission authority. */
import { dirname, join } from "node:path";
import { resolveHomeContext } from "../config/home.js";
import { parseToml } from "../config/loader.js";
import {
  assertNoSymlinkAncestors,
  readStableDirectory,
  readStableFile,
  stableUtf8Text,
} from "../config/stable-file.js";
import { resolveManagedConfigPath } from "../utils/settings/managedPath.js";

/**
 * Project only daemon.autostart from daemon-global files, using canonical
 * readers and precedence: default, user, managed base, sorted drop-ins.
 * Profiles deliberately fall back to the full resolver. No workspace, CLI
 * --config, or plugin source is a daemon-global authority.
 *
 * A boolean permits only the existing import-only provisional child. Full
 * canonical validation always runs afresh after trust and before ADMIT,
 * including unrelated invalid keys, retired sources and environment values.
 * null requests canonical resolution now; errors are never reformatted here.
 */
export async function tryReadDaemonAutostart(
  env: NodeJS.ProcessEnv,
  daemonHome: string,
  paths: { managedConfigPath?: string; managedDropInDir?: string } = {},
): Promise<boolean | null> {
  if (env.AGENC_PROFILE?.trim()) return null;
  try {
    const home = resolveHomeContext({ ...env, AGENC_HOME: daemonHome });
    const managedPath = paths.managedConfigPath ?? resolveManagedConfigPath(env);
    const dropInDir = paths.managedDropInDir ?? join(dirname(managedPath), "config.d");
    const identities = new Set<string>();
    const read = async (path: string, managed: boolean): Promise<boolean | undefined> => {
      const snapshot = await readStableFile(path, { allowLeafSymlink: !managed });
      if (snapshot === null) return undefined;
      if (managed && process.platform !== "win32" && (snapshot.mode & 0o022) !== 0) {
        throw new Error("uncertain managed source");
      }
      if (identities.has(snapshot.identity)) throw new Error("duplicate source");
      identities.add(snapshot.identity);
      const raw = parseToml(stableUtf8Text(snapshot), {
        onDuplicateKey: () => { throw new Error("duplicate key"); },
      });
      // A future config format must use the canonical path until reviewed.
      if (raw.config_version !== 2) throw new Error("unknown config version");
      const daemon = raw.daemon;
      if (daemon === undefined) return undefined;
      if (daemon === null || typeof daemon !== "object" || Array.isArray(daemon)) {
        throw new Error("invalid daemon table");
      }
      const value = daemon.autostart;
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error("invalid autostart value");
      }
      return value;
    };

    // Match managed source discovery, including code-unit sort and hidden-file
    // exclusion. Read managed first as the repository does, but apply it last.
    await assertNoSymlinkAncestors(managedPath);
    await assertNoSymlinkAncestors(dropInDir);
    const managedValues = [await read(managedPath, true)];
    let directory: Awaited<ReturnType<typeof readStableDirectory>>;
    try {
      directory = await readStableDirectory(dropInDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      directory = null;
    }
    const names = (directory?.entries ?? [])
      .map(entry => entry.name)
      .filter(name => name.endsWith(".toml") && !name.startsWith("."))
      .sort();
    for (const name of names) managedValues.push(await read(join(dropInDir, name), true));
    let value = (await read(home.configTomlPath, false)) ?? true;
    for (const managed of managedValues) value = managed ?? value;
    return value;
  } catch {
    return null;
  }
}
