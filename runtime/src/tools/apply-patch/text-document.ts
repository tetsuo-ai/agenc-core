import { Buffer } from "node:buffer";

import {
  assertApplyPatchActive,
  periodicallyAssertApplyPatchActive,
  type ApplyPatchControl,
} from "./control.js";
import {
  MAX_APPLY_PATCH_FILE_BYTES,
  MAX_APPLY_PATCH_FILE_LINES,
  MAX_APPLY_PATCH_LINE_BYTES,
  MAX_APPLY_PATCH_OUTPUT_LINES,
} from "./limits.js";
import { ApplyPatchRuntimeError } from "./types.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);
const UTF32_LE_BOM = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
const UTF32_BE_BOM = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
const UTF8_BOM_CHARACTER = "\ufeff";
const NUL_CODE_UNIT = 0;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

export type LineTerminator = "\n" | "\r\n" | "\r" | "";

export interface TextDocumentLine {
  readonly text: string;
  readonly terminator: LineTerminator;
}

export interface TextDocument {
  readonly originalContents: string;
  readonly hasUtf8Bom: boolean;
  readonly lines: readonly TextDocumentLine[];
  readonly hadFinalNewline: boolean;
  readonly preferredTerminator: Exclude<LineTerminator, "">;
}

export interface TextReplacement {
  readonly startIndex: number;
  readonly oldLength: number;
  readonly newLines: readonly string[];
}

interface OutputLine {
  readonly text: string;
  readonly originalTerminator: LineTerminator | null;
}

function startsWithBytes(bytes: Buffer, prefix: Buffer): boolean {
  return (
    bytes.length >= prefix.length &&
    bytes.subarray(0, prefix.length).equals(prefix)
  );
}

function unsupportedBom(bytes: Buffer): string | null {
  if (startsWithBytes(bytes, UTF32_LE_BOM)) return "UTF-32LE";
  if (startsWithBytes(bytes, UTF32_BE_BOM)) return "UTF-32BE";
  if (startsWithBytes(bytes, UTF16_LE_BOM)) return "UTF-16LE";
  if (startsWithBytes(bytes, UTF16_BE_BOM)) return "UTF-16BE";
  return null;
}

function validateTextCodeUnits(
  text: string,
  label: string,
  control: ApplyPatchControl | undefined,
): void {
  for (let offset = 0; offset < text.length; offset += 1) {
    periodicallyAssertApplyPatchActive(control, offset, "source validation");
    const codeUnit = text.charCodeAt(offset);
    if (codeUnit === NUL_CODE_UNIT) {
      throw new ApplyPatchRuntimeError(
        `${label} contains a NUL code unit at UTF-16 offset ${offset}`,
      );
    }
    if (codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END) {
      const next = text.charCodeAt(offset + 1);
      if (next < LOW_SURROGATE_START || next > LOW_SURROGATE_END) {
        throw new ApplyPatchRuntimeError(
          `${label} contains an unpaired high surrogate at UTF-16 offset ${offset}`,
        );
      }
      offset += 1;
      continue;
    }
    if (codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END) {
      throw new ApplyPatchRuntimeError(
        `${label} contains an unpaired low surrogate at UTF-16 offset ${offset}`,
      );
    }
  }
}

export function decodeApplyPatchFile(bytes: Buffer, path: string): string {
  if (bytes.length > MAX_APPLY_PATCH_FILE_BYTES) {
    throw new ApplyPatchRuntimeError(
      `${path} exceeds the ${MAX_APPLY_PATCH_FILE_BYTES}-byte apply_patch file limit`,
    );
  }
  const encoding = unsupportedBom(bytes);
  if (encoding !== null) {
    throw new ApplyPatchRuntimeError(
      `${path} uses unsupported ${encoding} encoding; apply_patch accepts UTF-8 only`,
    );
  }
  const hasUtf8Bom = startsWithBytes(bytes, UTF8_BOM);
  const payload = hasUtf8Bom ? bytes.subarray(UTF8_BOM.length) : bytes;
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(payload);
    return hasUtf8Bom ? `${UTF8_BOM_CHARACTER}${decoded}` : decoded;
  } catch {
    throw new ApplyPatchRuntimeError(
      `${path} is not valid UTF-8; apply_patch refuses lossy decoding`,
    );
  }
}

function splitLines(
  body: string,
  path: string,
  control: ApplyPatchControl | undefined,
): readonly TextDocumentLine[] {
  const lines: TextDocumentLine[] = [];
  let lineStart = 0;
  let offset = 0;
  const appendLine = (lineEnd: number, terminator: LineTerminator): void => {
    const text = body.slice(lineStart, lineEnd);
    if (Buffer.byteLength(text, "utf8") > MAX_APPLY_PATCH_LINE_BYTES) {
      throw new ApplyPatchRuntimeError(
        `${path} contains a line exceeding the ${MAX_APPLY_PATCH_LINE_BYTES}-byte limit`,
      );
    }
    lines.push({ text, terminator });
    if (lines.length > MAX_APPLY_PATCH_FILE_LINES) {
      throw new ApplyPatchRuntimeError(
        `${path} exceeds the ${MAX_APPLY_PATCH_FILE_LINES}-line apply_patch file limit`,
      );
    }
  };

  while (offset < body.length) {
    periodicallyAssertApplyPatchActive(control, offset, "source line scanning");
    const codeUnit = body.charCodeAt(offset);
    if (codeUnit === 0x0a) {
      appendLine(offset, "\n");
      offset += 1;
      lineStart = offset;
      continue;
    }
    if (codeUnit === 0x0d) {
      const isCrLf = body.charCodeAt(offset + 1) === 0x0a;
      appendLine(offset, isCrLf ? "\r\n" : "\r");
      offset += isCrLf ? 2 : 1;
      lineStart = offset;
      continue;
    }
    offset += 1;
  }
  if (lineStart < body.length) appendLine(body.length, "");
  return lines;
}

export function parseTextDocument(
  contents: string,
  path: string,
  control?: ApplyPatchControl,
): TextDocument {
  assertApplyPatchActive(control, "source decoding");
  validateTextCodeUnits(contents, path, control);
  if (Buffer.byteLength(contents, "utf8") > MAX_APPLY_PATCH_FILE_BYTES) {
    throw new ApplyPatchRuntimeError(
      `${path} exceeds the ${MAX_APPLY_PATCH_FILE_BYTES}-byte apply_patch file limit`,
    );
  }
  const hasUtf8Bom = contents.startsWith(UTF8_BOM_CHARACTER);
  const body = hasUtf8Bom
    ? contents.slice(UTF8_BOM_CHARACTER.length)
    : contents;
  const lines = splitLines(body, path, control);
  const lastTerminator = lines.at(-1)?.terminator;
  const firstTerminator = lines.find(
    (line) => line.terminator !== "",
  )?.terminator;
  return {
    originalContents: contents,
    hasUtf8Bom,
    lines,
    hadFinalNewline: lastTerminator !== undefined && lastTerminator !== "",
    preferredTerminator: firstTerminator || "\n",
  };
}

function validateReplacementRange(
  replacement: TextReplacement,
  sourceLength: number,
  minimumStart: number,
): void {
  if (
    !Number.isSafeInteger(replacement.startIndex) ||
    !Number.isSafeInteger(replacement.oldLength) ||
    replacement.startIndex < minimumStart ||
    replacement.oldLength < 0 ||
    replacement.startIndex + replacement.oldLength > sourceLength
  ) {
    throw new ApplyPatchRuntimeError(
      "apply_patch produced an invalid or overlapping replacement range",
    );
  }
}

function buildOutputLines(
  document: TextDocument,
  replacements: readonly TextReplacement[],
  control: ApplyPatchControl | undefined,
): readonly OutputLine[] {
  const output: OutputLine[] = [];
  const appendOutputLine = (line: OutputLine): void => {
    output.push(line);
    if (output.length > MAX_APPLY_PATCH_OUTPUT_LINES) {
      throw new ApplyPatchRuntimeError(
        `apply_patch output exceeds the ${MAX_APPLY_PATCH_OUTPUT_LINES}-line limit`,
      );
    }
  };
  let sourceIndex = 0;
  for (
    let replacementIndex = 0;
    replacementIndex < replacements.length;
    replacementIndex += 1
  ) {
    periodicallyAssertApplyPatchActive(
      control,
      replacementIndex,
      "output planning",
    );
    const replacement = replacements[replacementIndex]!;
    validateReplacementRange(replacement, document.lines.length, sourceIndex);
    while (sourceIndex < replacement.startIndex) {
      const source = document.lines[sourceIndex]!;
      appendOutputLine({
        text: source.text,
        originalTerminator: source.terminator,
      });
      sourceIndex += 1;
    }
    for (const text of replacement.newLines) {
      appendOutputLine({ text, originalTerminator: null });
    }
    sourceIndex += replacement.oldLength;
  }
  while (sourceIndex < document.lines.length) {
    const source = document.lines[sourceIndex]!;
    appendOutputLine({
      text: source.text,
      originalTerminator: source.terminator,
    });
    sourceIndex += 1;
  }
  return output;
}

function nextOriginalTerminators(
  output: readonly OutputLine[],
): readonly (Exclude<LineTerminator, ""> | null)[] {
  const next = new Array<Exclude<LineTerminator, ""> | null>(output.length);
  let nearest: Exclude<LineTerminator, ""> | null = null;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    next[index] = nearest;
    const terminator = output[index]?.originalTerminator;
    if (terminator !== null && terminator !== undefined && terminator !== "") {
      nearest = terminator;
    }
  }
  return next;
}

export function applyTextReplacements(
  document: TextDocument,
  replacements: readonly TextReplacement[],
  control?: ApplyPatchControl,
): string {
  const output = buildOutputLines(document, replacements, control);
  const nextTerminators = nextOriginalTerminators(output);
  const parts: string[] = [];
  let outputBytes = 0;
  const append = (part: string): void => {
    outputBytes += Buffer.byteLength(part, "utf8");
    if (outputBytes > MAX_APPLY_PATCH_FILE_BYTES) {
      throw new ApplyPatchRuntimeError(
        `apply_patch output exceeds the ${MAX_APPLY_PATCH_FILE_BYTES}-byte limit`,
      );
    }
    parts.push(part);
  };

  if (document.hasUtf8Bom) append(UTF8_BOM_CHARACTER);
  let previousOriginalTerminator: Exclude<LineTerminator, ""> | null = null;
  for (let index = 0; index < output.length; index += 1) {
    periodicallyAssertApplyPatchActive(control, index, "output construction");
    const line = output[index]!;
    const isFinal = index === output.length - 1;
    const fallbackTerminator =
      previousOriginalTerminator ??
      nextTerminators[index] ??
      document.preferredTerminator;
    let terminator = line.originalTerminator;
    if (isFinal && !document.hadFinalNewline) {
      terminator = "";
    } else if (terminator === null) {
      terminator = fallbackTerminator;
    } else if (terminator === "" && !isFinal) {
      terminator = fallbackTerminator;
    }
    append(line.text);
    append(terminator);
    if (line.originalTerminator !== null && line.originalTerminator !== "") {
      previousOriginalTerminator = line.originalTerminator;
    }
  }
  assertApplyPatchActive(control, "output construction");
  return parts.join("");
}
