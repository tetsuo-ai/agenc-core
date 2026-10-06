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
 * Other harnesses' tool names, as `toolNameKey` values, and the AgenC tools to
 * point to, in order of preference. An entry points to the closest tool for
 * the same single job. It does not claim the two take the same arguments,
 * which is why the message says the tool has its own parameters. Left out:
 * multi-purpose tools with no single counterpart (`str_replace_editor` also
 * views and creates files; `replace_in_file` applies several blocks per
 * call), and names that mean different jobs in different harnesses
 * (`search_files`, `todo`, `search`, `task`, `exec`).
 */
export const FOREIGN_TOOL_NAME_TARGETS: ReadonlyArray<{
  readonly names: readonly string[];
  readonly tools: readonly string[];
}> = [
  {
    names: ["read", "readfile", "viewfile", "openfile", "filereadtool"],
    tools: ["FileRead"],
  },
  {
    names: ["editfile", "fileedit", "fileedittool", "strreplace", "replace", "searchreplace"],
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
    names: ["grepsearch", "searchfilecontent", "ripgrep", "rg"],
    tools: ["Grep"],
  },
  { names: ["filesearch", "findfiles", "findbyname"], tools: ["Glob"] },
  {
    names: ["ls", "listdir", "listdirectory", "listfiles"],
    tools: ["system.listDir", "Glob"],
  },
  { names: ["fetch", "fetchurl"], tools: ["web_fetch"] },
  { names: ["googlewebsearch", "searchweb"], tools: ["WebSearch"] },
  { names: ["updateplan"], tools: ["TodoWrite"] },
  { names: ["agent", "subagent"], tools: ["spawn_agent"] },
  { names: ["askuser", "askfollowupquestion"], tools: ["AskUserQuestion"] },
  { names: ["patch"], tools: ["apply_patch"] },
];

/**
 * The available tool `requested` most likely meant, or undefined without a
 * clear match. An available name that differs only in case or separators
 * wins (`grep` -> `Grep`) unless more than one does; otherwise the first
 * available target from `FOREIGN_TOOL_NAME_TARGETS`.
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
  const target = FOREIGN_TOOL_NAME_TARGETS.find((entry) =>
    entry.names.includes(key),
  );
  return target?.tools.find((tool) => available.has(tool));
}

/** What a suggestion needs to know about one tool the session can dispatch. */
export interface ToolSuggestionCandidate {
  readonly name: string;
  /** In this request's tool list, so the model already has its schema. */
  readonly offered: boolean;
  /** Deferred: the tool-search tool can load its schema. */
  readonly deferred: boolean;
  /** Hidden from discovery (`metadata.hiddenByDefault`). */
  readonly hidden: boolean;
  /** Kept by the router for telemetry only (`ConfiguredToolSpec.unavailable`). */
  readonly unavailable: boolean;
}

export interface ToolSuggestion {
  readonly name: string;
  /** Set when the schema is not loaded yet: the search tool that loads it. */
  readonly loadWith?: string;
}

/**
 * Which tools may be named for an unknown call, and in what order. Tools
 * offered in this request come first. A deferred tool that is not hidden
 * comes next, and only while the tool-search tool is offered, because one
 * search call loads it. Everything else was withheld from the model: marked
 * unavailable, hidden from discovery, or left out of this request by a
 * filter. It is never named, even when the registry lists it.
 */
export function suggestToolForUnknownName(
  requested: string,
  candidates: readonly ToolSuggestionCandidate[],
  searchToolName: string,
): ToolSuggestion | undefined {
  const usable = candidates.filter((candidate) => !candidate.unavailable);
  const offered = usable
    .filter((candidate) => candidate.offered)
    .map((candidate) => candidate.name);
  const direct = suggestAvailableToolName(requested, offered);
  if (direct !== undefined) return { name: direct };
  if (!offered.includes(searchToolName)) return undefined;
  const loadable = usable
    .filter((candidate) => !candidate.offered && candidate.deferred && !candidate.hidden)
    .map((candidate) => candidate.name);
  const viaSearch = suggestAvailableToolName(requested, loadable);
  return viaSearch === undefined
    ? undefined
    : { name: viaSearch, loadWith: searchToolName };
}

/**
 * Terminal error text for an unknown tool; unchanged without a suggestion.
 * The suggestion is stated as a fact, not an instruction: the system prompt
 * tells the model not to follow tool-use directives inside tool results.
 */
export function formatUnknownToolMessage(
  requested: string,
  suggestion: string | undefined,
  loadWith?: string,
): string {
  const message = `No such tool available: ${requested}`;
  if (suggestion === undefined) return message;
  const closest =
    `${message}. The closest available tool is ${suggestion}, ` +
    `which has its own parameters.`;
  return loadWith === undefined
    ? closest
    : `${closest} Its schema is not loaded yet; ${loadWith} with select:${suggestion} loads it.`;
}
