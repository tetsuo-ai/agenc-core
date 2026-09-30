// Root review utility: seal the existing clean product tree before a build.
// Does not build, import product code, install dependencies or contact a provider.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const core = '/private/tmp/light-clean-cli-validator-v2-GANyA9/source';
const repo = '/private/tmp/light-takeover/startup-core';
const here = path.dirname(fileURLToPath(import.meta.url));
const revision = '403da04398b55e51d1f4e8814f9a70957b0db5ef';
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination) || fs.existsSync(destination)) throw Error('new absolute manifest path required');
const within = name => name === core || name.startsWith(core + '/');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let gitFiles = 0;
const tree = execFileSync('git', ['ls-tree', '-r', '-z', revision], {cwd: repo, maxBuffer: 16 * 1024 * 1024}).toString();
for (const entry of tree.split('\0').filter(Boolean)) {
  const tab = entry.indexOf('\t'), [mode, type, hash] = entry.slice(0, tab).split(' ');
  if (type !== 'blob') throw Error('unexpected Git object');
  const file = path.join(core, entry.slice(tab + 1));
  if (!within(file)) throw Error('path escape');
  const bytes = mode === '120000' ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== hash) throw Error('clean source differs from selected Git object');
  gitFiles++;
}
const files = {}, visited = new Set();
let totalBytes = 0;
function include(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > 256 * 1024 * 1024) throw Error('input exceeds builder bound');
  files[file] = sha(bytes); totalBytes += bytes.length;
}
function walk(named) {
  const file = fs.realpathSync(named);
  if (!within(file)) throw Error('dependency link escapes accepted root');
  if (visited.has(file)) return;
  visited.add(file);
  const st = fs.lstatSync(file);
  if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name));
  else if (st.isFile()) include(file);
  else throw Error('non-regular source entry');
}
walk(core);
for (const name of ['owner-entry.ts', 'companion-validator.ts', 'selection.mjs', 'compatibility-selection.mjs',
  'empty-resources.mjs', 'build-companion.mjs']) include(path.join(here, name));
include(path.join(here, '../luna-observer-v6/direct.mjs'));
include('/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.8.1/bin/node');
const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
const bytes = Buffer.from(JSON.stringify({schemaVersion: 1, productRevision: revision,
  scope: 'local build-only accepted source plus existing clean installed dependencies; not deployment attestation',
  gitFilesVerified: gitFiles, files: ordered}, null, 2) + '\n');
if (bytes.length > 16 * 1024 * 1024 || Object.keys(files).length > 100000) throw Error('inventory exceeds builder bounds');
fs.writeFileSync(destination, bytes, {flag: 'wx', mode: 0o600});
console.log(JSON.stringify({manifest: destination, sha256: sha(bytes), gitFilesVerified: gitFiles,
  inputCount: Object.keys(files).length, inputBytes: totalBytes}));
