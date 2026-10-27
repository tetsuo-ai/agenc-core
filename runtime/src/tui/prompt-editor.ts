import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigEditorCommand, spawnConfigEditor } from "../config/editor.js";
import { getAgenCHomeDir } from "../utils/envUtils.js";
import { getExternalEditor } from "../utils/editor.js";

/** Edit a private draft using the same terminal handoff as config editing. */
export async function editPromptDraft(text: string): Promise<string | null> {
  const editor = getExternalEditor();
  if (editor === undefined) throw new Error("No external editor is available. Set EDITOR or VISUAL.");
  const home = getAgenCHomeDir();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(home, "prompt-editor-"));
  const file = join(directory, "prompt.txt");
  try {
    await writeFile(file, text, { mode: 0o600 });
    const { command, args } = parseConfigEditorCommand(editor);
    const code = await spawnConfigEditor(command, [...args, file]);
    if (code !== 0) return null;
    return await readFile(file, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
