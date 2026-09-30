// One-use preservation import, not a benchmark launcher. Original bytes remain.
// Sources are task-specific operator artifacts; they are NOT runtime plugins.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [source, publicDestination, privateDestination, mode = '--audit'] = process.argv.slice(2);
if (![source, publicDestination, privateDestination].every(p => typeof p === 'string' && path.isAbsolute(p))
  || !['--audit', '--copy'].includes(mode)) throw new Error('absolute paths and --audit/--copy required');
if (fs.realpathSync(source) !== source || [publicDestination, privateDestination].some(p => p === source
  || (p.startsWith(source + '/') && !['startup-core/', 'archive-repository/'].some(prefix => path.relative(source, p).startsWith(prefix)))))
  throw new Error('source must be canonical; nested destinations must be excluded repository trees');
const roots = new Set(['cli-boundary-diagnostic', 'cli-policy-recovery', 'edit-efficiency', 'evaluation-audit',
  'fair-confirmation', 'final-a793fdb-validation', 'final-b82ae4d-validation', 'full-suite-triage',
  'local-compaction-403da', 'local-validation-28e', 'local-validation-assembly-phase1',
  'local-validation-cli-validator', 'local-validation-cli-validator-v2', 'local-validation-prepared-integration',
  'local-validation-recovery-final', 'local-validation-responses-eof', 'luna-stop-resolution',
  'responses-terminal-safety', 'result-projection', 'startup-cache', 'startup-cpu', 'truncated-recovery-validation']);
const rootCode = new Set(['audit_scores.py', 'test_audit_scores.py', 'request-correlation-typecheck.mjs',
  'build-final-a793fdb.sh', 'build-final-b82ae4d.sh']);
const codeExtensions = new Set(['.py', '.mjs', '.ts', '.mts', '.sh', '.patch', '.c']);
const evidenceExtensions = new Set([...codeExtensions, '.json', '.md', '.log', '.tap', '.txt', '.csv', '.out', '.err']);
const skipDirs = new Set(['node_modules', '.git', '__pycache__', '.venv']);
const records = [], excluded = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const patterns = {
  private_key: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  provider_token: /\b(?:sk-(?:proj-)?|xai-|hf_|gh[pousr]_)[A-Za-z0-9_-]{24,}\b/,
  bearer_token: /Bearer\s+[A-Za-z0-9_.-]{40,}/,
  password_literal: /\b(?:password|passwd)\s*[=:]\s*["'][^"'\r\n]{6,}["']/i,
  opaque_reasoning: /"encrypted_content"\s*:\s*"[A-Za-z0-9_+/=-]{80,}"/,
};
function refuse(relative, reason) {excluded.push({path: relative, reason});}
function inspect(relative, topLevel = false) {
  const filename = path.join(source, relative), stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return refuse(relative, 'non_regular');
  if (stat.isDirectory()) {
    if (skipDirs.has(path.basename(relative))) return refuse(relative, 'dependency_or_cache');
    if (topLevel && !roots.has(relative)) return refuse(relative, 'outside_selected_light_artifact_roots');
    for (const name of fs.readdirSync(filename).sort()) inspect(path.join(relative, name));
    return;
  }
  if (/^\.env(?:\.|$)|^\.npmrc$|(?:^|[._-])(?:credentials?|cookies?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(path.basename(relative)))
    return refuse(relative, 'credential_named_file');
  if (!evidenceExtensions.has(path.extname(relative))) return refuse(relative, 'binary_or_unselected_extension');
  if (stat.size > 16 * 1024 * 1024) return refuse(relative, 'over_16MiB_review_required');
  if (relative.startsWith('fair-confirmation/current-cli-observer-v1/')
    && ['fixture-callbacks.ts', 'fixture-callbacks.test.mjs'].includes(path.basename(relative)))
    return refuse(relative, 'moving_worker_file_hold');
  const raw = fs.readFileSync(filename), text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  if (text.includes('\0')) return refuse(relative, 'binary_content_review_required');
  const candidates = Object.entries(patterns).filter(([, expression]) => expression.test(text)).map(([name]) => name);
  if (candidates.length) return refuse(relative, 'content_review_required:' + candidates.join(','));
  const generated = relative === 'fair-confirmation/real-parent-bridge-build-v1/canonical-bridge.mjs';
  const publicCode = !generated && (topLevel ? rootCode.has(relative)
    : codeExtensions.has(path.extname(relative)) || path.basename(relative) === 'source-pins.json'
      || /^tsconfig.*\.json$/.test(path.basename(relative)));
  records.push({path: relative, bytes: raw.length, sha256: sha(raw), publicCode});
}
for (const name of fs.readdirSync(source).sort()) inspect(name, true);
const summary = {selectedFiles: records.length, publicCodeFiles: records.filter(r => r.publicCode).length,
  privateBytes: records.reduce((n, r) => n + r.bytes, 0), excluded: excluded.length,
  needsContentReview: excluded.filter(r => r.reason.startsWith('content_review_required:')).map(r => r.path)};
if (mode === '--audit') {
  console.log(JSON.stringify({summary, excluded}, null, 2));
} else {
  if ([publicDestination, privateDestination].some(p => fs.existsSync(p))) throw new Error('destination already exists; no overwrite');
  // Detect moving source before publishing anything. No background mutation is
  // tolerated as an implicit new version; excluded working files stay local.
  for (const record of records) if (sha(fs.readFileSync(path.join(source, record.path))) !== record.sha256)
    throw new Error('source changed before import');
  fs.mkdirSync(publicDestination, {recursive: true}); fs.mkdirSync(privateDestination, {recursive: true, mode: 0o700});
  for (const record of records) {
    const raw = fs.readFileSync(path.join(source, record.path));
    if (sha(raw) !== record.sha256) throw new Error('source changed during import');
    for (const destination of [privateDestination, ...(record.publicCode ? [publicDestination] : [])]) {
      const filename = path.join(destination, record.path);
      fs.mkdirSync(path.dirname(filename), {recursive: true});
      fs.writeFileSync(filename, raw, {flag: 'wx', mode: 0o600});
    }
  }
  const manifest = {schema_version: 1, source, scope: 'retained Light operator work; preservation only',
    publicCodeFiles: summary.publicCodeFiles, files: records, exclusions: excluded};
  fs.writeFileSync(path.join(privateDestination, 'PRESERVATION-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  fs.writeFileSync(path.join(publicDestination, 'SOURCE-MANIFEST.json'), JSON.stringify({schema_version: 1,
    scope: 'experimental source preservation, not installed or approved to execute',
    files: records.filter(r => r.publicCode).map(({path, bytes, sha256}) => ({path, bytes, sha256}))}, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(summary));
}
