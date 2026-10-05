import { z } from "zod/v4";

// Exact schema definitions from combo3 aea72f3a25cb, kept as the differential oracle.
const fileReadInputSchema = z.strictObject({
  file_path: z.string(),
  offset: z.union([z.number(), z.string().regex(/^[1-9]\d*$/)]).optional(),
  limit: z.union([z.number(), z.string().regex(/^[1-9]\d*$/)]).optional(),
  pages: z.string().optional(),
});

const fileEditInputSchema = z.strictObject({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const fileWriteInputSchema = z.strictObject({
  file_path: z.string(),
  content: z.string(),
});

const grepInputSchema = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  "-B": z.number().optional(),
  "-A": z.number().optional(),
  "-C": z.number().optional(),
  context: z.number().optional(),
  "-n": z.boolean().optional(),
  "-i": z.boolean().optional(),
  head_limit: z.number().optional(),
  offset: z.number().optional(),
  multiline: z.boolean().optional(),
});

const globInputSchema = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
});

const bashInputSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
});

const notebookEditInputSchema = z.strictObject({
  notebook_path: z.string(),
  cell_id: z.string().optional(),
  new_source: z.string().optional(),
  cell_type: z.enum(["code", "markdown"]).optional(),
  edit_mode: z.enum(["replace", "insert", "delete"]).optional(),
});

export const originalSchemas = {
  fileRead: fileReadInputSchema,
  fileEdit: fileEditInputSchema,
  fileWrite: fileWriteInputSchema,
  grep: grepInputSchema,
  glob: globInputSchema,
  bash: bashInputSchema,
  notebookEdit: notebookEditInputSchema,
};
