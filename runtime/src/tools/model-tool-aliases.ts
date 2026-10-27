/** Exact compatibility spellings. Canonical tools still own schemas and policy. */
const aliases: Readonly<Record<string, string>> = Object.freeze({
  Read: "FileRead", read: "FileRead", read_file: "FileRead", readFile: "FileRead",
  FileWrite: "Write", write_file: "Write", writeFile: "Write",
  FileEdit: "Edit", edit_file: "Edit", editFile: "Edit",
  Bash: "system.bash", bash: "system.bash", Shell: "system.bash", shell: "system.bash",
  grep: "Grep", ripgrep: "Grep", glob: "Glob",
  LS: "system.listDir", ls: "system.listDir", list_directory: "system.listDir", listDir: "system.listDir",
});

export function modelToolAliasTarget(name: string): string | undefined {
  return Object.hasOwn(aliases, name) ? aliases[name] : undefined;
}

export function resolveModelToolAlias(name: string, available: Iterable<string>): string {
  const target = modelToolAliasTarget(name);
  if (target === undefined) return name;
  const names = new Set(available);
  // An actually registered tool wins over a compatibility spelling.
  if (names.has(name)) return name;
  return names.has(target) ? target : name;
}
