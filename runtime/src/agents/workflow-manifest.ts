/** Descriptor-confined named workflow manifest loader. */

import {
  constants as fsConstants,
  type BigIntStats,
} from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  win32,
} from "node:path";

import {
  MAX_WORKFLOW_MANIFEST_BYTES,
  parseWorkflowManifestBytes,
  type NormalizedWorkflowManifest,
} from "./workflow-manifest-schema.js";

export const MAX_WORKFLOW_NAME_CODEPOINTS = 128;
export const MAX_WORKFLOW_NAME_UTF8_BYTES = 250;
export const MAX_WORKFLOW_NAME_UTF16_CODE_UNITS = 250;
export const MAX_WORKFLOW_MANIFEST_BASENAME_BYTES_OR_CODE_UNITS = 255;
export const WORKFLOW_MANIFEST_SUFFIX = ".json";
export const MAX_WORKFLOW_SEARCH_ROOTS = 2;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const PATH_SEPARATOR_PATTERN = /[\\/]/u;
const WINDOWS_FORBIDDEN_CHARACTER_PATTERN = /[<>:"|?*]/u;
const WINDOWS_RESERVED_BASENAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_TRAILING_DOT_OR_SPACE_PATTERN = /[. ]$/u;

export interface ValidatedWorkflowName {
  readonly name: string;
  readonly manifestBasename: string;
}

export interface WorkflowManifestLoaderHooks {
  readonly afterRootOpen?: (root: string) => void | Promise<void>;
  readonly afterCandidateOpen?: (candidate: string) => void | Promise<void>;
}

export interface LoadNamedWorkflowManifestOptions {
  readonly name: string;
  /** Ordered, trusted roots. The workspace root normally precedes AGENC_HOME. */
  readonly roots: readonly string[];
  /** Test/platform seam for a filesystem with a component limit below 255. */
  readonly maximumBasenameBytesOrCodeUnits?: number;
  readonly hooks?: WorkflowManifestLoaderHooks;
}

export interface LoadedWorkflowManifest {
  readonly name: string;
  readonly manifestBasename: string;
  readonly sourceRoot: string;
  readonly sourcePath: string;
  readonly searchedPaths: readonly string[];
  readonly document: NormalizedWorkflowManifest;
}

export class WorkflowManifestPathError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowManifestPathError";
    this.code = code;
  }
}

export class WorkflowManifestNotFoundError extends WorkflowManifestPathError {
  readonly searchedPaths: readonly string[];

  constructor(name: string, searchedPaths: readonly string[]) {
    super(
      "WORKFLOW_NOT_FOUND",
      `workflow ${JSON.stringify(name)} was not found beneath a trusted workflow root`,
    );
    this.name = "WorkflowManifestNotFoundError";
    this.searchedPaths = Object.freeze([...searchedPaths]);
  }
}

export function validateWorkflowName(
  name: string,
  maximumBasenameBytesOrCodeUnits =
    MAX_WORKFLOW_MANIFEST_BASENAME_BYTES_OR_CODE_UNITS,
): ValidatedWorkflowName {
  if (typeof name !== "string" || name.length === 0) {
    throw pathError("WORKFLOW_NAME", "workflow name must be a non-empty string");
  }
  if (
    !Number.isSafeInteger(maximumBasenameBytesOrCodeUnits) ||
    maximumBasenameBytesOrCodeUnits < WORKFLOW_MANIFEST_SUFFIX.length ||
    maximumBasenameBytesOrCodeUnits >
      MAX_WORKFLOW_MANIFEST_BASENAME_BYTES_OR_CODE_UNITS
  ) {
    throw new TypeError(
      `maximumBasenameBytesOrCodeUnits must be an integer between ${WORKFLOW_MANIFEST_SUFFIX.length} and ${MAX_WORKFLOW_MANIFEST_BASENAME_BYTES_OR_CODE_UNITS}`,
    );
  }
  if (
    name === "." ||
    name === ".." ||
    isAbsolute(name) ||
    win32.isAbsolute(name) ||
    PATH_SEPARATOR_PATTERN.test(name) ||
    CONTROL_CHARACTER_PATTERN.test(name) ||
    WINDOWS_FORBIDDEN_CHARACTER_PATTERN.test(name) ||
    WINDOWS_TRAILING_DOT_OR_SPACE_PATTERN.test(name) ||
    WINDOWS_RESERVED_BASENAME_PATTERN.test(name)
  ) {
    throw pathError(
      "WORKFLOW_NAME",
      "workflow name must be one portable, non-control, non-absolute basename",
    );
  }
  if (!isWellFormedUnicode(name)) {
    throw pathError(
      "WORKFLOW_NAME_UNICODE",
      "workflow name must not contain lone UTF-16 surrogates",
    );
  }
  if (
    basename(name) !== name ||
    win32.basename(name) !== name ||
    normalize(name) !== name ||
    win32.normalize(name) !== name ||
    name.normalize("NFC") !== name
  ) {
    throw pathError(
      "WORKFLOW_NAME",
      "workflow name must not change during basename or Unicode normalization",
    );
  }
  if ([...name].length > MAX_WORKFLOW_NAME_CODEPOINTS) {
    throw pathError(
      "WORKFLOW_NAME_CODEPOINTS",
      `workflow name exceeds ${MAX_WORKFLOW_NAME_CODEPOINTS} code points`,
    );
  }
  if (name.length > MAX_WORKFLOW_NAME_UTF16_CODE_UNITS) {
    throw pathError(
      "WORKFLOW_NAME_UTF16",
      `workflow name exceeds ${MAX_WORKFLOW_NAME_UTF16_CODE_UNITS} UTF-16 code units`,
    );
  }
  if (Buffer.byteLength(name, "utf8") > MAX_WORKFLOW_NAME_UTF8_BYTES) {
    throw pathError(
      "WORKFLOW_NAME_UTF8",
      `workflow name exceeds ${MAX_WORKFLOW_NAME_UTF8_BYTES} UTF-8 bytes`,
    );
  }

  const manifestBasename = `${name}${WORKFLOW_MANIFEST_SUFFIX}`;
  const manifestUtf8Bytes = Buffer.byteLength(manifestBasename, "utf8");
  const manifestUtf16CodeUnits = manifestBasename.length;
  if (
    manifestUtf8Bytes > maximumBasenameBytesOrCodeUnits ||
    manifestUtf16CodeUnits > maximumBasenameBytesOrCodeUnits
  ) {
    throw pathError(
      "WORKFLOW_BASENAME_LIMIT",
      `workflow manifest basename exceeds the ${maximumBasenameBytesOrCodeUnits}-unit filesystem component limit`,
    );
  }
  return Object.freeze({ name, manifestBasename });
}

export async function loadNamedWorkflowManifest(
  options: LoadNamedWorkflowManifestOptions,
): Promise<LoadedWorkflowManifest> {
  if (
    !Array.isArray(options.roots) ||
    options.roots.length === 0 ||
    options.roots.length > MAX_WORKFLOW_SEARCH_ROOTS
  ) {
    throw new TypeError(
      `workflow roots must contain between 1 and ${MAX_WORKFLOW_SEARCH_ROOTS} paths`,
    );
  }
  const validated = validateWorkflowName(
    options.name,
    options.maximumBasenameBytesOrCodeUnits,
  );
  const roots = options.roots.map((root) => {
    if (typeof root !== "string" || root.length === 0) {
      throw new TypeError("workflow root must be a non-empty path");
    }
    return resolve(root);
  });
  const searchedPaths = Object.freeze(
    roots.map((root) => join(root, validated.manifestBasename)),
  );

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index]!;
    const bytes = await readManifestFromRoot(
      root,
      validated.manifestBasename,
      options.hooks,
    );
    if (bytes === undefined) continue;
    const sourcePath = searchedPaths[index]!;
    return Object.freeze({
      ...validated,
      sourceRoot: root,
      sourcePath,
      searchedPaths,
      document: parseWorkflowManifestBytes(bytes, sourcePath),
    });
  }
  throw new WorkflowManifestNotFoundError(options.name, searchedPaths);
}

async function readManifestFromRoot(
  root: string,
  manifestBasename: string,
  hooks: WorkflowManifestLoaderHooks | undefined,
): Promise<Buffer | undefined> {
  let lexicalRoot: BigIntStats;
  try {
    lexicalRoot = await lstat(root, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw pathError(
      "WORKFLOW_ROOT_OPEN",
      `could not inspect workflow root ${root}`,
      error,
    );
  }
  if (!lexicalRoot.isDirectory() || lexicalRoot.isSymbolicLink()) {
    throw pathError(
      "WORKFLOW_ROOT_UNSAFE",
      `workflow root must be a real non-symlink directory: ${root}`,
    );
  }
  const canonicalRoot = await realpath(root);
  let rootHandle: FileHandle | undefined;
  try {
    rootHandle = await open(root, directoryOpenFlags());
    const openedRoot = await rootHandle.stat({ bigint: true });
    if (!openedRoot.isDirectory() || !sameIdentity(lexicalRoot, openedRoot)) {
      throw pathError(
        "WORKFLOW_ROOT_RACE",
        `workflow root changed while opening: ${root}`,
      );
    }
    const operationRoot =
      (await descriptorDirectoryPath(rootHandle, canonicalRoot)) ?? root;
    await hooks?.afterRootOpen?.(root);
    await assertRootCurrent(root, canonicalRoot, openedRoot, rootHandle);
    return await readManifestCandidate(
      root,
      canonicalRoot,
      operationRoot,
      openedRoot,
      rootHandle,
      manifestBasename,
      hooks,
    );
  } catch (error) {
    if (error instanceof WorkflowManifestPathError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENAMETOOLONG" || code === "EINVAL") {
      throw pathError(
        "WORKFLOW_BASENAME_UNSUPPORTED",
        `filesystem rejected workflow manifest basename ${JSON.stringify(manifestBasename)}`,
        error,
      );
    }
    throw pathError(
      "WORKFLOW_ROOT_OPEN",
      `could not safely read workflow root ${root}: ${errorMessage(error)}`,
      error,
    );
  } finally {
    await rootHandle?.close().catch(() => {});
  }
}

async function readManifestCandidate(
  lexicalRoot: string,
  canonicalRoot: string,
  operationRoot: string,
  openedRoot: BigIntStats,
  rootHandle: FileHandle,
  manifestBasename: string,
  hooks: WorkflowManifestLoaderHooks | undefined,
): Promise<Buffer | undefined> {
  const operationPath = join(operationRoot, manifestBasename);
  const lexicalPath = join(lexicalRoot, manifestBasename);
  let pathBefore: BigIntStats;
  try {
    pathBefore = await lstat(operationPath, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw pathError(
      "WORKFLOW_MANIFEST_UNSAFE",
      `workflow manifest must be a regular non-symlink file: ${lexicalPath}`,
    );
  }
  if (pathBefore.size > BigInt(MAX_WORKFLOW_MANIFEST_BYTES)) {
    throw pathError(
      "WORKFLOW_MANIFEST_BYTES",
      `workflow manifest exceeds ${MAX_WORKFLOW_MANIFEST_BYTES} bytes: ${lexicalPath}`,
    );
  }

  const candidateHandle = await open(operationPath, fileOpenFlags());
  try {
    const opened = await candidateHandle.stat({ bigint: true });
    if (!opened.isFile() || !sameSnapshot(pathBefore, opened)) {
      throw pathError(
        "WORKFLOW_MANIFEST_RACE",
        `workflow manifest changed while opening: ${lexicalPath}`,
      );
    }
    const canonicalCandidate = await realpath(operationPath);
    if (
      dirname(canonicalCandidate) !== canonicalRoot ||
      basename(canonicalCandidate) !== manifestBasename
    ) {
      throw pathError(
        "WORKFLOW_MANIFEST_ESCAPE",
        `workflow manifest resolves outside its trusted root: ${lexicalPath}`,
      );
    }
    await hooks?.afterCandidateOpen?.(lexicalPath);
    const buffer = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await candidateHandle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [after, pathAfter] = await Promise.all([
      candidateHandle.stat({ bigint: true }),
      lstat(operationPath, { bigint: true }),
    ]);
    if (
      offset !== buffer.byteLength ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(opened, pathAfter) ||
      pathAfter.isSymbolicLink()
    ) {
      throw pathError(
        "WORKFLOW_MANIFEST_RACE",
        `workflow manifest changed while reading: ${lexicalPath}`,
      );
    }
    await assertRootCurrent(
      lexicalRoot,
      canonicalRoot,
      openedRoot,
      rootHandle,
    );
    return buffer;
  } finally {
    await candidateHandle.close();
  }
}

async function assertRootCurrent(
  lexicalRoot: string,
  canonicalRoot: string,
  openedRoot: BigIntStats,
  rootHandle: FileHandle,
): Promise<void> {
  try {
    const [lexical, canonical, opened] = await Promise.all([
      lstat(lexicalRoot, { bigint: true }),
      realpath(lexicalRoot),
      rootHandle.stat({ bigint: true }),
    ]);
    if (
      !lexical.isDirectory() ||
      lexical.isSymbolicLink() ||
      !opened.isDirectory() ||
      !sameIdentity(lexical, openedRoot) ||
      !sameIdentity(opened, openedRoot) ||
      canonical !== canonicalRoot
    ) {
      throw pathError(
        "WORKFLOW_ROOT_RACE",
        `workflow root changed during manifest load: ${lexicalRoot}`,
      );
    }
  } catch (error) {
    if (error instanceof WorkflowManifestPathError) throw error;
    throw pathError(
      "WORKFLOW_ROOT_RACE",
      `workflow root changed during manifest load: ${lexicalRoot}`,
      error,
    );
  }
}

function directoryOpenFlags(): number {
  const directory =
    (fsConstants as typeof fsConstants & { readonly O_DIRECTORY?: number })
      .O_DIRECTORY ?? 0;
  return fsConstants.O_RDONLY | directory | noFollowFlag();
}

function fileOpenFlags(): number {
  return fsConstants.O_RDONLY | noFollowFlag();
}

function noFollowFlag(): number {
  return (
    (fsConstants as typeof fsConstants & { readonly O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0
  );
}

async function descriptorDirectoryPath(
  handle: FileHandle,
  canonicalRoot: string,
): Promise<string | undefined> {
  const candidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${handle.fd}`];
  for (const candidate of candidates) {
    try {
      if ((await realpath(candidate)) === canonicalRoot) return candidate;
    } catch {
      // Platforms without descriptor aliases use the identity-checked path.
    }
  }
  return undefined;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

function pathError(
  code: string,
  message: string,
  cause?: unknown,
): WorkflowManifestPathError {
  return new WorkflowManifestPathError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
