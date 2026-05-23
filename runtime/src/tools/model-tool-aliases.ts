import { FILE_EDIT_TOOL_NAME } from "./system/file-edit.js";
import { FILE_READ_TOOL_NAME } from "./system/file-read.js";
import { FILE_WRITE_TOOL_NAME } from "./system/file-write.js";

const MODEL_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  Read: FILE_READ_TOOL_NAME,
  FileReadTool: FILE_READ_TOOL_NAME,
  FileEdit: FILE_EDIT_TOOL_NAME,
  FileEditTool: FILE_EDIT_TOOL_NAME,
  FileWrite: FILE_WRITE_TOOL_NAME,
  FileWriteTool: FILE_WRITE_TOOL_NAME,
});

export function canonicalModelToolName(name: string): string {
  return MODEL_TOOL_NAME_ALIASES[name] ?? name;
}
