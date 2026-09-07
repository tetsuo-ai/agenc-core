/** Descriptor-confined named workflow manifest loader. */

import {
  basename,
  isAbsolute,
  join,
  normalize,
  resolve,
  win32,
} from "node:path";
import {
  ConfinedIoError,
  readConfinedFile,
  withConfinedDirectory,
  withRegularChild,
  type ConfinedIoPolicy,
} from "../fs/descriptor-confined-io.js";

import {
  MAX_WORKFLOW_MANIFEST_BYTES,
  parseWorkflowManifestBytes,
  type ValidatedWorkflowManifest,
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
  readonly document: ValidatedWorkflowManifest;
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

const MANIFEST_IO_POLICY = Object.freeze({
  hardLinks: "allow",
  privateDirectory: false,
  privateFile: false,
  unavailableAlias: "identity-checked-path",
} satisfies ConfinedIoPolicy);

const MANIFEST_IO_ERROR_CODES = {
  ROOT_UNSAFE: "WORKFLOW_ROOT_UNSAFE",
  ROOT_CHANGED: "WORKFLOW_ROOT_RACE",
  DESCRIPTOR_UNSUPPORTED: "WORKFLOW_ROOT_OPEN",
  CHILD_UNSAFE: "WORKFLOW_MANIFEST_UNSAFE",
  CHILD_CHANGED: "WORKFLOW_MANIFEST_RACE",
  CHILD_OUTSIDE_ROOT: "WORKFLOW_MANIFEST_ESCAPE",
  CHILD_TOO_LARGE: "WORKFLOW_MANIFEST_BYTES",
} as const satisfies Record<ConfinedIoError["code"], string>;

async function readManifestFromRoot(
  root: string,
  manifestBasename: string,
  hooks: WorkflowManifestLoaderHooks | undefined,
): Promise<Buffer | undefined> {
  try {
    return await withConfinedDirectory(
      root,
      MANIFEST_IO_POLICY,
      (directory) => withRegularChild(
        directory,
        manifestBasename,
        { maximumBytes: MAX_WORKFLOW_MANIFEST_BYTES },
        readConfinedFile,
        hooks,
      ),
      hooks,
    );
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    if (error instanceof ConfinedIoError) {
      throw pathError(MANIFEST_IO_ERROR_CODES[error.code], error.message, error);
    }
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
  }
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
