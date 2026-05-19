#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsRoot = resolve(runtimeRoot, 'logs');
const reportPath = resolve(reportsRoot, 'unused-code.md');
const jsonReportPath = resolve(reportsRoot, 'unused-code.json');

const { stdout, stderr } = await execa(
  'knip',
  [
    '--config',
    'knip.config.mjs',
    '--production',
    '--reporter',
    'json',
    '--no-exit-code',
    '--no-progress',
  ],
  {
    cwd: runtimeRoot,
    reject: false,
  },
);

const issueTypes = [
  'files',
  'dependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'exports',
  'types',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
];
const parsed = JSON.parse(stdout);

function issueEntries(type) {
  return parsed.issues.flatMap((issue) => {
    const file = typeof issue.file === 'string' ? issue.file : '';
    const entries = Array.isArray(issue[type]) ? issue[type] : [];
    return entries.map((entry) => {
      if (Array.isArray(entry)) {
        return {
          file,
          name: entry
            .map((item) =>
              typeof item === 'object' && item !== null && 'name' in item
                ? String(item.name)
                : String(item),
            )
            .join(' | '),
        };
      }
      if (typeof entry === 'object' && entry !== null && 'name' in entry) {
        return { file, name: String(entry.name) };
      }
      return { file, name: String(entry) };
    });
  });
}

function markdownTable(headers, rows) {
  if (rows.length === 0) return '_None reported._';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`),
  ].join('\n');
}

function topFileGroups(files) {
  const counts = new Map();
  for (const file of files) {
    const parts = file.split('/');
    const group = parts[0] === 'src' && parts.length > 2
      ? `${parts[0]}/${parts[1]}`
      : parts.slice(0, 2).join('/');
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 25)
    .map(([group, count]) => [group, String(count)]);
}

function sampleRows(type, limit = 40) {
  return issueEntries(type)
    .slice(0, limit)
    .map((entry) => [entry.file, entry.name]);
}

const counts = issueTypes.map((type) => {
  const count = issueEntries(type).length;
  return [type, String(count)];
});
const unusedFiles = issueEntries('files').map((entry) => entry.name);
const generatedAt = new Date().toISOString();
const body = [
  `# Unused Code Report`,
  ``,
  `Generated: ${generatedAt}`,
  `Command: \`knip --config knip.config.mjs --production --reporter json --no-exit-code --no-progress\``,
  `Full JSON: \`${jsonReportPath}\``,
  ``,
  `## Counts`,
  ``,
  markdownTable(['Issue type', 'Count'], counts),
  ``,
  `## Unused Files By Area`,
  ``,
  markdownTable(['Area', 'Count'], topFileGroups(unusedFiles)),
  ``,
  `## Sample Unused Files`,
  ``,
  markdownTable(['File', 'Name'], sampleRows('files')),
  ``,
  `## Sample Unresolved Imports`,
  ``,
  markdownTable(['File', 'Import'], sampleRows('unresolved')),
  ``,
  `## Sample Unlisted Dependencies`,
  ``,
  markdownTable(['File', 'Dependency'], sampleRows('unlisted')),
  ``,
  `## Sample Unused Exports`,
  ``,
  markdownTable(['File', 'Export'], sampleRows('exports')),
  ``,
  stderr.trim() ? `\n## Stderr\n\n\`\`\`text\n${stderr.trim()}\n\`\`\`\n` : '',
].join('\n');

await mkdir(reportsRoot, { recursive: true });
await writeFile(jsonReportPath, `${JSON.stringify(parsed, null, 2)}\n`);
await writeFile(reportPath, `${body.trimEnd()}\n`);
console.log(`Wrote ${reportPath}`);
console.log(`Wrote ${jsonReportPath}`);
