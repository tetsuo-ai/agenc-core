/**
 * The closest available tool for an unknown tool name.
 *
 * Models trained on other harnesses call tools by those harnesses' names
 * (`Read`, `edit_file`, `bash`). Core never aliases a name: the call still
 * fails with its terminal error. The error names the tool the model most
 * likely meant, so it can correct in one step. A suggestion needs a clear
 * match and is always one of the names the caller says are available.
 *
 * @module
 */

/** Lowercase letters and digits only, so `edit_file` and `EditFile` compare equal. */
function toolNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Other harnesses' tool names, as `toolNameKey` values, and the AgenC tools
 * that do the same job, in order of preference. Only names with one clear
 * equivalent belong here; `search`, `task` or `exec` would be guesses.
 */
export const FOREIGN_TOOL_NAME_EQUIVALENTS: ReadonlyArray<{
  readonly names: readonly string[];
  readonly tools: readonly string[];
}> = [
  {
    names: ["read", "readfile", "viewfile", "openfile", "filereadtool"],
    tools: ["FileRead"],
  },
  {
    names: [
      "editfile", "fileedit", "fileedittool", "strreplace", "strreplaceeditor",
      "strreplacebasededittool", "replace", "replaceinfile", "searchreplace",
      "replacefilecontent",
    ],
    tools: ["Edit"],
  },
  {
    names: ["writefile", "writetofile", "createfile", "filewrite", "filewritetool"],
    tools: ["Write"],
  },
  {
    names: [
      "bash", "shell", "localshell", "terminal", "runshellcommand", "runterminalcmd",
      "runterminalcommand", "executecommand", "executebash", "runcommand",
    ],
    tools: ["exec_command", "system.bash"],
  },
  { names: ["killshell", "killbash"], tools: ["kill_process"] },
  {
    names: ["grepsearch", "searchfilecontent", "searchfiles", "ripgrep", "rg"],
    tools: ["Grep"],
  },
  { names: ["filesearch", "findfiles", "findbyname"], tools: ["Glob"] },
  {
    names: ["ls", "listdir", "listdirectory", "listfiles"],
    tools: ["system.listDir", "Glob"],
  },
  { names: ["fetch", "fetchurl"], tools: ["web_fetch"] },
  { names: ["googlewebsearch", "searchweb"], tools: ["WebSearch"] },
  { names: ["todo", "updateplan"], tools: ["TodoWrite"] },
  { names: ["agent", "subagent"], tools: ["spawn_agent"] },
  { names: ["askuser", "askfollowupquestion"], tools: ["AskUserQuestion"] },
  { names: ["patch"], tools: ["apply_patch"] },
];

/**
 * The available tool `requested` most likely meant, or undefined without a
 * clear match. An available name that differs only in case or separators
 * wins (`grep` -> `Grep`) unless more than one does; otherwise the first
 * available equivalent from `FOREIGN_TOOL_NAME_EQUIVALENTS`.
 */
export function suggestAvailableToolName(
  requested: string,
  availableToolNames: Iterable<string>,
): string | undefined {
  const available = new Set(availableToolNames);
  if (available.has(requested)) return undefined;
  const key = toolNameKey(requested);
  if (key.length === 0) return undefined;
  const sameKey = [...available].filter((name) => toolNameKey(name) === key);
  if (sameKey.length > 0) return sameKey.length === 1 ? sameKey[0] : undefined;
  const equivalent = FOREIGN_TOOL_NAME_EQUIVALENTS.find((entry) =>
    entry.names.includes(key),
  );
  return equivalent?.tools.find((tool) => available.has(tool));
}

/**
 * Terminal error text for an unknown tool; unchanged without a suggestion.
 * The suggestion is stated as a fact, not an instruction: the system prompt
 * tells the model not to follow tool-use directives inside tool results.
 */
export function formatUnknownToolMessage(
  requested: string,
  suggestion: string | undefined,
): string {
  const message = `No such tool available: ${requested}`;
  if (suggestion === undefined) return message;
  return (
    `${message}. The closest available tool is ${suggestion}, ` +
    `which has its own parameters.`
  );
}
