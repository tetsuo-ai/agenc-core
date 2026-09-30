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
const predecessor = ['light-runtime', 'light-ultra', 'light-port', 'light-diag', 'light-models'].includes(path.basename(source));
const frozenSelections = new Map([
  ['/private/tmp/light-runtime/core/runtime/benchmarks/runtime-overhead',
    ['REPORT.md', 'ROUND2.md', 'summarize.py', 'test_summarize.py']],
  ['/private/tmp/light-takeover/fair-confirmation/current-cli-observer-v1',
    ['fixture-callbacks.ts', 'fixture-callbacks.test.ts', 'vitest.callbacks.config.mts',
      'tsconfig.callbacks.json', 'check-callbacks.mjs', 'CALLBACK-VALIDATION.md',
      'callback-checks-first', 'callback-checks-corrected', 'build-companion.mjs',
      'seal-build-inputs.mjs', 'COMPANION-BUILD.md', 'COMPANION-BUILD-RESULT.md',
      'companion-build-inputs-v1.json', 'companion-build-inputs-v2.json', 'BUILD-EXTERNAL-REVIEW.md',
      'COMPANION-SPLIT-RESULT.md', 'smoke-disabled-companion.mjs', 'callback-observer-child.mjs',
      'callback-observer.test.mjs', 'check-observer-integration.mjs', 'OBSERVER-INTEGRATION-RESULT.md',
      'observer-check-first']],
  ['/private/tmp/light-ultra/bench', ['scan_credentials.py']],
  ['/private/tmp/light-port/bench', ['review_credential_scan.py', 'scan_task_credentials.py']],
]);
const privateSelections = new Map([
  ['/private/tmp/light-models/evidence', ['grok-admissions.jsonl', 'minimax-admissions.jsonl',
    'openai-admissions.jsonl', 'sol-relay-admissions.jsonl', 'spend-grok.jsonl',
    'spend-minimax.jsonl', 'spend-openai.jsonl']],
  ['/private/tmp/light-ultra/evidence', ['cache-fixture-timings.jsonl']],
  ['/private/tmp/light-companion-build-v1', ['selection.json', 'build-result.json',
    'metafile.json', 'reviewed-build-config.mjs']],
  ['/private/tmp/light-companion-build-v2', ['selection.json', 'build-result.json',
    'metafile.json', 'reviewed-build-config.mjs', 'disabled-entry-smoke.json']],
  ...['cQGTZZ', 's1uUGY', 'o2Nz01'].map(id => ['/private/tmp/cli-callback-observer-' + id,
    ['run', 'financial', 'selection.json', 'child.log', 'parent-lifecycle.json', 'parent-artifacts.json']]),
]);
const frozenSelection = frozenSelections.get(source) ?? privateSelections.get(source);
if (!predecessor && !frozenSelection && path.basename(source) !== 'light-takeover') throw new Error('unselected source root');
const codeExtensions = new Set(['.py', '.mjs', '.cjs', '.ts', '.mts', '.sh', '.patch', '.c']);
const evidenceExtensions = new Set([...codeExtensions, '.json', '.md', '.log', '.tap', '.txt', '.csv', '.out', '.err', '.fails']);
const publicSourceJson = new Set([
  'light-models/harness/pricing.json', 'light-models/harness/tasks/manifest.json',
  'light-port/bench/harness/pricing.json', 'light-port/bench/harness/tasks/manifest.json',
  'light-port/bench/harness-fair/pricing.json', 'light-port/bench/harness-fair/tasks/manifest.json',
  'light-ultra/bench/tasks/manifest.json', 'light-ultra/bench/converge/pricing.json',
  'light-ultra/bench/converge/tasks/manifest.json', 'light-ultra/bench/luna-api/pricing.json',
  'light-ultra/bench/luna-api/tasks/manifest.json',
]);
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
  if (frozenSelection && !frozenSelection.some(selected => relative === selected || relative.startsWith(selected + '/'))) return;
  const filename = path.join(source, relative), stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return refuse(relative, 'non_regular');
  if (stat.isDirectory()) {
    if (skipDirs.has(path.basename(relative))) return refuse(relative, 'dependency_or_cache');
    if (predecessor && (fs.existsSync(path.join(filename, '.git'))
      || ['sources', 'pi-source', 'pi-reference-full', 'raw'].includes(path.basename(relative))))
      return refuse(relative, 'embedded_repository_third_party_or_raw_capture');
    if (!predecessor && !frozenSelection && topLevel && !roots.has(relative)) return refuse(relative, 'outside_selected_light_artifact_roots');
    for (const name of fs.readdirSync(filename).sort()) inspect(path.join(relative, name));
    return;
  }
  if (path.basename(relative).startsWith('._')) return refuse(relative, 'appledouble_metadata');
  if (predecessor && (/^codex.*\.log$/.test(path.basename(relative))
    || ['grok_credentials.mjs', 'minimax_secret.py'].includes(path.basename(relative))))
    return refuse(relative, 'private_session_or_credential_helper_review_required');
  if (!frozenSelections.get(source)?.includes(relative)
    && /^\.env(?:\.|$)|^\.npmrc$|(?:^|[._-])(?:credentials?|cookies?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(path.basename(relative)))
    return refuse(relative, 'credential_named_file');
  if (!evidenceExtensions.has(path.extname(relative)) && !privateSelections.get(source)?.some(selected => relative === selected || relative.startsWith(selected + '/')))
    return refuse(relative, 'binary_or_unselected_extension');
  if (stat.size > 16 * 1024 * 1024) return refuse(relative, 'over_16MiB_review_required');
  if (relative.startsWith('fair-confirmation/current-cli-observer-v1/')
    && ['fixture-callbacks.ts', 'fixture-callbacks.test.ts', 'fixture-callbacks.test.mjs'].includes(path.basename(relative)))
    return refuse(relative, 'moving_worker_file_hold');
  const raw = fs.readFileSync(filename), text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  if (text.includes('\0')) return refuse(relative, 'binary_content_review_required');
  const candidates = Object.entries(patterns).filter(([, expression]) => expression.test(text)).map(([name]) => name);
  if (candidates.length) return refuse(relative, 'content_review_required:' + candidates.join(','));
  const generated = relative === 'fair-confirmation/real-parent-bridge-build-v1/canonical-bridge.mjs';
  const predecessorPublic = publicSourceJson.has(path.basename(source) + '/' + relative)
    || codeExtensions.has(path.extname(relative)) && (topLevel
    || relative.startsWith('harness/') || relative.startsWith('bench/')
    || ['evidence/measured-baseline.patch', 'evidence/runner-initial.py'].includes(relative));
  const publicCode = frozenSelections.has(source) ? !relative.startsWith('callback-checks-')
      && !relative.startsWith('observer-check-') && !/^companion-build-inputs-v[12]\.json$/.test(relative)
    : !privateSelections.has(source) && !generated && (predecessor ? predecessorPublic : topLevel ? rootCode.has(relative)
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
