import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, isAbsolute, dirname, basename } from "node:path";
import { createHash, createPublicKey, verify, randomBytes, type KeyObject } from "node:crypto";

export interface DesktopAuthorityProof { readonly id: string; readonly signature: string }
export interface DesktopAuthorityGrant { readonly id: string; readonly expiresAt: number; readonly socketPath: string; readonly socketIdentity: string }
const grants = new WeakSet<object>();
const publicKeys = new WeakMap<object, KeyObject>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READS = new Set(["desktop_state", "desktop_window_state", "browser_tabs", "browser_snapshot", "browser_read_text", "browser_screenshot", "browser_wait_for", "browser_downloads", "browser_console", "terminal_list", "terminal_read"]);
// Browser v1 contract: isolated no-Node contents, http(s)-only navigation,
// owner-targeted tabs, automatic downloads blocked before any file creation.
const UI_MUTATIONS = new Set(["desktop_settings_open", "desktop_settings_update", "desktop_window", "desktop_session_open", "desktop_session_update", "desktop_project_select", "browser_open_tab", "browser_select_tab", "browser_close_tab", "browser_navigate", "browser_click", "browser_type", "browser_press_key", "browser_scroll", "browser_back", "browser_forward", "browser_reload", "browser_evaluate"]);

/** Exact protocol keys, independent of insertion order or host locale. */
function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length &&
    keys.every(key => typeof key === "string" && expected.includes(key));
}

async function privateSocketIdentity(socketPath: unknown): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined || typeof socketPath !== "string" || !isAbsolute(socketPath) ||
      Buffer.byteLength(socketPath) > 103 || basename(socketPath) !== "control.sock") throw new Error("Invalid Desktop socket");
  const parentPath = dirname(socketPath);
  if (!/^agenc-dc-[A-Za-z0-9]{6}$/.test(basename(parentPath)) ||
      dirname(parentPath) !== await realpath("/tmp") || await realpath(parentPath) !== parentPath) throw new Error("Invalid Desktop socket parent");
  const parent = await lstat(parentPath);
  const socket = await lstat(socketPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o7777) !== 0o700 ||
      !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || socket.nlink !== 1 || (socket.mode & 0o7777) !== 0o600) throw new Error("Invalid Desktop socket ownership");
  return `${parent.dev}:${parent.ino}:${socket.dev}:${socket.ino}`;
}

/** Revalidate the pinned private socket before every HTTP request. There is no
 * TCP fallback: cross-account port rebinding cannot receive a bearer. The host
 * OS and processes running as the same user remain a trusted boundary. */
export async function assertDesktopSocketBinding(grant: DesktopAuthorityGrant): Promise<void> {
  try {
    if (!hasDesktopAuthority(grant) || await privateSocketIdentity(grant.socketPath) !== grant.socketIdentity) throw new Error("changed");
  } catch { throw new Error("Desktop control private socket authority is unavailable"); }
}

export function desktopAuthorityProofIssue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "desktopAuthority must be an object";
  const object = value as Record<string, unknown>;
  if (!hasExactOwnKeys(object, ["id", "signature"]) || typeof object.id !== "string" || !UUID.test(object.id) ||
    typeof object.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(object.signature)) return "desktopAuthority requires a UUID and Ed25519 signature";
  return undefined;
}

/** The public record is operator-owned bootstrap state, never workspace/MCP data. */
export async function verifyDesktopAuthority(config: {
  readonly name: string; readonly endpoint?: string; readonly localOnly?: boolean;
  readonly headers?: Readonly<Record<string, string>>; readonly desktopAuthority?: DesktopAuthorityProof;
}, agencHome: string | undefined): Promise<DesktopAuthorityGrant | undefined> {
  if (config.desktopAuthority === undefined) return undefined;
  const deny = () => new Error("Desktop control host authority could not be verified");
  if (desktopAuthorityProofIssue(config.desktopAuthority) || config.name !== "agenc-desktop-control" || config.localOnly !== true || !agencHome || !isAbsolute(agencHome)) throw deny();
  const authorization = Object.entries(config.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  if (!authorization) throw deny();
  const directory = join(agencHome, "desktop-control-authorities");
  const uid = process.getuid?.();
  if (uid === undefined) throw deny(); // Do not pretend POSIX mode proof works on Windows.
  try {
    const home = await lstat(agencHome);
    if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== uid || (home.mode & 0o022) !== 0) throw deny();
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o700) throw deny();
    const file = await open(join(directory, `${config.desktopAuthority.id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096) throw deny();
      const record = JSON.parse(await file.readFile("utf8")) as Record<string, unknown>;
      if (!hasExactOwnKeys(record, ["expiresAt", "publicKey", "socketPath", "version"]) || record.version !== 2 || typeof record.publicKey !== "string" ||
        !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= Date.now() || (record.expiresAt as number) > Date.now() + 13 * 60 * 60 * 1000) throw deny();
      const socketIdentity = await privateSocketIdentity(record.socketPath);
      const key = createPublicKey(record.publicKey);
      if (key.asymmetricKeyType !== "ed25519") throw deny();
      const material = JSON.stringify([2, config.name, config.endpoint, createHash("sha256").update(authorization).digest("hex"), 1, record.socketPath]);
      if (!verify(null, Buffer.from(material), key, Buffer.from(config.desktopAuthority.signature, "base64"))) throw deny();
      const grant = Object.freeze({ id: config.desktopAuthority.id, expiresAt: record.expiresAt as number, socketPath: record.socketPath as string, socketIdentity });
      grants.add(grant);
      publicKeys.set(grant, key);
      return grant;
    } finally { await file.close(); }
  } catch { throw deny(); }
}

/** Fresh proof of the live host over the verified private Unix socket before
 * disclosing a bearer on initial/reconnect. */
export async function attestDesktopEndpoint(config: {
  readonly name: string; readonly endpoint: string; readonly headers?: Readonly<Record<string, string>>;
  readonly desktopAuthorityGrant?: DesktopAuthorityGrant;
}, fetcher: typeof fetch = fetch): Promise<void> {
  const grant = config.desktopAuthorityGrant;
  if (grant === undefined) return;
  const key = publicKeys.get(grant);
  const authorization = Object.entries(config.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const deny = () => new Error("Live Desktop control host authority could not be verified");
  if (!hasDesktopAuthority(grant) || !key || !authorization) throw deny();
  const authorizationHash = createHash("sha256").update(authorization).digest("hex");
  const nonce = randomBytes(32).toString("hex");
  try {
    await assertDesktopSocketBinding(grant);
    const response = await fetcher(`${config.endpoint}/authority`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce, authorizationHash }) });
    if (!response.ok || !response.body) throw deny();
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) {
          break;
        }
        size += item.value.length;
        if (size > 1024) {
          throw deny();
        }
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (!hasExactOwnKeys(body, ["signature"]) || typeof body.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(body.signature)) throw deny();
    const material = JSON.stringify([3, config.name, config.endpoint, authorizationHash, nonce, grant.socketPath]);
    if (!verify(null, Buffer.from(material), key, Buffer.from(body.signature, "base64"))) throw deny();
  } catch { throw deny(); }
}

/** Provenance only: callers must never use this to authorize execution. It
 * keeps an expired private binding from reviving legacy wrong-window tools. */
export function isDesktopAuthorityGrant(grant: DesktopAuthorityGrant | undefined): boolean {
  return grant !== undefined && grants.has(grant);
}

export function hasDesktopAuthority(grant: DesktopAuthorityGrant | undefined): boolean {
  return isDesktopAuthorityGrant(grant) && grant!.expiresAt > Date.now();
}

/** Closed product-owned capability classification; server annotations cannot grant it. */
export function desktopToolClassification(grant: DesktopAuthorityGrant | undefined, name: string): "read" | "ui-mutation" | undefined {
  if (!hasDesktopAuthority(grant)) return undefined;
  if (READS.has(name)) return "read";
  if (UI_MUTATIONS.has(name)) return "ui-mutation";
  return undefined;
}
