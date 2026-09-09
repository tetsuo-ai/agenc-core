import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { digestCanonicalJson, type Sha256Digest } from "../eval-contract/index.js";
import { OVERLAY_AGENT_ENTRY_SUBPATH } from "./overlay-paths.js";
import { EvalExecutorError } from "./source-lock.js";

const ROOTS = new Set(["node", "runtime", "mock", "proxy"]);
export const OVERLAY_VERSION_SUBPATH = "runtime/node_modules/@tetsuo-ai/runtime/dist/VERSION";
const REQUIRED_FILES = [
  "node/bin/node", "node/compat/libatomic.so.1", OVERLAY_AGENT_ENTRY_SUBPATH,
  OVERLAY_VERSION_SUBPATH, "mock/serve.mjs",
];
const EGRESS_FILES = ["proxy/allowlist-proxy.mjs", "proxy/eval-egress-probe.mjs"];
const PathSchema = z.string().refine((value) => (
  !/[\\\u0000-\u001f\u007f]/u.test(value) &&
  ROOTS.has(value.split("/")[0] ?? "") &&
  value.split("/").every((component) => component !== "" && component !== "." && component !== "..")
));
const DigestSchema = z.custom<Sha256Digest>(
  (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
);

export const OverlayManifestSchema = z.strictObject({
  kind: z.literal("agenc.eval.executor-overlay-manifest"),
  version: z.literal("1.0.0"),
  mode: z.enum(["offline", "real-provider"]),
  files: z.array(z.strictObject({
    path: PathSchema,
    digest: DigestSchema,
    sizeBytes: z.number().int().nonnegative(),
    mode: z.number().int().min(0).max(0o7777),
  })),
  links: z.array(z.strictObject({ path: PathSchema, target: z.string().min(1) })),
}).superRefine((manifest, context) => {
  const names = new Set<string>();
  for (const entries of [manifest.files, manifest.links]) {
    let previous = "";
    for (const entry of entries) {
      if (entry.path <= previous || names.has(entry.path)) {
        context.addIssue({ code: "custom", message: "overlay entries must be sorted and unique" });
      }
      previous = entry.path;
      names.add(entry.path);
    }
  }
  for (const link of manifest.links) {
    const target = path.posix.join(path.posix.dirname(link.path), link.target);
    if (path.posix.isAbsolute(link.target) || !PathSchema.safeParse(target).success) {
      context.addIssue({ code: "custom", message: "overlay links must stay within known overlay roots" });
    }
  }
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  for (const required of [...REQUIRED_FILES, ...(manifest.mode === "real-provider" ? EGRESS_FILES : [])]) {
    if (!files.has(required)) {
      context.addIssue({ code: "custom", message: `agent overlay is missing regular file ${required}` });
    }
  }
  if (files.get(OVERLAY_VERSION_SUBPATH)?.sizeBytes === 0) {
    context.addIssue({ code: "custom", message: "agent overlay VERSION is empty" });
  }
});

export type OverlayManifest = z.infer<typeof OverlayManifestSchema>;

export function computeOverlayManifestDigest(manifest: OverlayManifest): Sha256Digest {
  return digestCanonicalJson("agenc.eval.executor-overlay-manifest.v1", manifest);
}

function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function hashFile(filePath: string, expected: Stats): Promise<Sha256Digest> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    if (!sameFile(expected, await handle.stat())) {
      throw new EvalExecutorError([`agent overlay changed while reading ${filePath}`]);
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (!sameFile(expected, await handle.stat()) || !sameFile(expected, await lstat(filePath))) {
      throw new EvalExecutorError([`agent overlay changed while reading ${filePath}`]);
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function readInternalLink(root: string, filePath: string, relativePath: string): Promise<OverlayManifest["links"][number]> {
  const target = await readlink(filePath);
  const resolved = path.relative(root, await realpath(filePath));
  if (path.isAbsolute(target) || resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
    throw new EvalExecutorError([`agent overlay link escapes its root: ${relativePath}`]);
  }
  return { path: relativePath, target };
}

export async function readOverlayManifest(
  overlay: { readonly hostDir: string },
  options: { readonly egress?: boolean } = {},
): Promise<OverlayManifest> {
  try {
    const root = await realpath(overlay.hostDir);
    const files: OverlayManifest["files"] = [];
    const links: OverlayManifest["links"] = [];
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const entries = await readdir(directory);
      for (const name of entries.sort()) {
        if (prefix === "" && !ROOTS.has(name)) {
          throw new EvalExecutorError([`unexpected agent overlay entry ${name}`]);
        }
        const relativePath = prefix === "" ? name : `${prefix}/${name}`;
        const filePath = path.join(directory, name);
        const metadata = await lstat(filePath);
        if (prefix === "" && !metadata.isDirectory()) {
          throw new EvalExecutorError([`agent overlay root ${name} must be a directory`]);
        }
        if (metadata.isDirectory()) {
          await visit(filePath, relativePath);
        } else if (metadata.isSymbolicLink()) {
          links.push(await readInternalLink(root, filePath, relativePath));
        } else if (metadata.isFile()) {
          files.push({
            path: relativePath, digest: await hashFile(filePath, metadata),
            sizeBytes: metadata.size, mode: metadata.mode & 0o7777,
          });
        } else {
          throw new EvalExecutorError([`unsupported agent overlay entry ${relativePath}`]);
        }
      }
    };
    await visit(root, "");
    const byPath = (first: { path: string }, second: { path: string }) => {
      if (first.path === second.path) return 0;
      return first.path < second.path ? -1 : 1;
    };
    const parsed = OverlayManifestSchema.safeParse({
      kind: "agenc.eval.executor-overlay-manifest", version: "1.0.0",
      mode: options.egress ? "real-provider" : "offline",
      files: files.sort(byPath), links: links.sort(byPath),
    });
    if (!parsed.success) {
      throw new EvalExecutorError(parsed.error.issues.map((issue) => issue.message));
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof EvalExecutorError) throw error;
    throw new EvalExecutorError([`cannot attest agent overlay: ${error instanceof Error ? error.message : String(error)}`]);
  }
}
