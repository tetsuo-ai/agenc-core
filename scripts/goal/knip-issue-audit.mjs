export const KNIP_UNUSED_ISSUE_TYPES = [
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
  "exports",
  "types",
];

export function collectKnipUnusedIssueEntries(report) {
  const entries = [];
  for (const issue of Array.isArray(report?.issues) ? report.issues : []) {
    const file = issue?.file;
    if (typeof file !== "string") continue;
    for (const key of KNIP_UNUSED_ISSUE_TYPES) {
      const value = issue?.[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item?.name === "string") entries.push({ file, type: key, name: item.name });
      }
    }
    const enumMembers = issue?.enumMembers;
    if (enumMembers && typeof enumMembers === "object") {
      for (const [enumName, members] of Object.entries(enumMembers)) {
        if (!Array.isArray(members)) continue;
        for (const member of members) {
          const memberName = typeof member?.name === "string" ? member.name : String(member);
          entries.push({ file, type: "enumMembers", name: `${enumName}.${memberName}` });
        }
      }
    }
  }
  return entries;
}

export function normalizeKnipIssueIgnoreEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    if (typeof entry?.file !== "string" || typeof entry?.type !== "string") {
      throw new Error(`entry ${index + 1} must include file and type`);
    }
    if (typeof entry.name === "string") return { file: entry.file, type: entry.type, name: entry.name };
    if (typeof entry.namePattern === "string") {
      return { file: entry.file, type: entry.type, namePattern: new RegExp(`^(?:${entry.namePattern})$`) };
    }
    throw new Error(`entry ${index + 1} must include name or namePattern`);
  });
}

export function isIgnoredKnipIssue(entry, ignoreEntries) {
  return ignoreEntries.some((ignored) =>
    ignored.file === entry.file &&
      ignored.type === entry.type &&
      (ignored.name === entry.name || ignored.namePattern?.test(entry.name)),
  );
}

export function isKnipIgnoreEntryUsed(ignored, issueEntries) {
  return issueEntries.some((entry) =>
    ignored.file === entry.file &&
      ignored.type === entry.type &&
      (ignored.name === entry.name || ignored.namePattern?.test(entry.name)),
  );
}

export function findUnignoredKnipIssues(issueEntries, ignoreEntries) {
  return issueEntries.filter((entry) => !isIgnoredKnipIssue(entry, ignoreEntries));
}

export function findStaleKnipIssueIgnores(ignoreEntries, issueEntries) {
  return ignoreEntries.filter((entry) => !isKnipIgnoreEntryUsed(entry, issueEntries));
}

export function collectKnipIssueTypesByFile(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    const types = byFile.get(entry.file) ?? new Set();
    types.add(entry.type);
    byFile.set(entry.file, types);
  }
  return Object.fromEntries(
    [...byFile.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, types]) => [file, [...types].sort()]),
  );
}

export function stripKnipIssueAllowlists(config) {
  const stripped = structuredClone(config);
  delete stripped.ignoreIssues;
  if (stripped.workspaces && typeof stripped.workspaces === "object") {
    for (const workspace of Object.values(stripped.workspaces)) {
      if (workspace && typeof workspace === "object") delete workspace.ignoreIssues;
    }
  }
  return stripped;
}
