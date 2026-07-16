/**
 * Ports the upstream memory path-scoping and memory secret-screening helpers
 * onto AgenC's explicit D-13 memory privacy surface.
 *
 * Why this lives here / shape difference from upstream:
 *   - Durable memory paths are split into AgenC global and project layers.
 *   - Team-memory sync transport stays outside this file; this module owns
 *     only local path classification and pre-write/pre-upload screening.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Team sync transport and remote API behavior remain in
 *     runtime/src/services/teamMemorySync/.
 */
import { feature } from 'bun:bundle'
import { normalize, posix, win32 } from 'path'

import {
  getAutoMemPath,
  getGlobalMemoryPath,
  getMemoryBaseDir,
  isAutoMemoryEnabled,
} from './paths.js'
import * as teamMemPathsModule from '../memdir/teamMemPaths.js'
import { isAnyAgentMemoryPath } from '../tools/AgentTool/agentMemory.js'
import { getAgenCConfigHomeDir } from '../utils/envUtils.js'
import { capitalize } from '../utils/stringUtils.js'
import {
  posixPathToWindowsPath,
  windowsPathToPosixPath,
} from '../utils/windowsPaths.js'

type SecretRule = {
  id: string
  source: string
  flags?: string
}

export type SecretMatch = {
  ruleId: string
  label: string
}

export type MemoryScope = 'personal' | 'team'
export type SessionFileType = 'session_memory' | 'session_transcript'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM') ? teamMemPathsModule : null
/* eslint-enable @typescript-eslint/no-require-imports */

const IS_WINDOWS = process.platform === 'win32'

function toPosix(p: string): string {
  return p.split(win32.sep).join(posix.sep)
}

function toComparable(p: string): string {
  const posixForm = toPosix(p)
  return IS_WINDOWS ? posixForm.toLowerCase() : posixForm
}

function toComparablePath(p: string): string {
  const normalized = toComparable(normalize(p)).replace(/\/+$/, '')
  return normalized || posix.sep
}

function isSameOrChildPath(candidate: string, base: string): boolean {
  const candidateCmp = toComparablePath(candidate)
  const baseCmp = toComparablePath(base)
  if (baseCmp === posix.sep) {
    return candidateCmp.startsWith(posix.sep)
  }
  return candidateCmp === baseCmp || candidateCmp.startsWith(`${baseCmp}/`)
}

/**
 * Detects if a file path is a session-related file under ~/.agenc.
 */
export function detectSessionFileType(
  filePath: string,
): SessionFileType | null {
  const configDir = getAgenCConfigHomeDir()
  const normalized = toComparablePath(filePath)
  if (!isSameOrChildPath(filePath, configDir)) {
    return null
  }
  if (normalized.includes('/session-memory/') && normalized.endsWith('.md')) {
    return 'session_memory'
  }
  if (normalized.includes('/projects/') && normalized.endsWith('.jsonl')) {
    return 'session_transcript'
  }
  return null
}

/**
 * Checks if a glob/pattern string indicates session file access intent.
 */
export function detectSessionPatternType(
  pattern: string,
): SessionFileType | null {
  const normalized = pattern.split(win32.sep).join(posix.sep)
  const segments = normalized.split(posix.sep).filter(Boolean)
  if (
    normalized.includes('session-memory') &&
    (normalized.includes('.md') || normalized.endsWith('*'))
  ) {
    return 'session_memory'
  }
  if (
    (segments.length <= 1 || segments.includes('projects')) &&
    (normalized.includes('.jsonl') || normalized.includes('*.jsonl'))
  ) {
    return 'session_transcript'
  }
  return null
}

export function isAutoMemFile(filePath: string): boolean {
  if (isAutoMemoryEnabled()) {
    return (
      isSameOrChildPath(filePath, getGlobalMemoryPath()) ||
      isSameOrChildPath(filePath, getAutoMemPath())
    )
  }
  return false
}

export function memoryScopeForPath(filePath: string): MemoryScope | null {
  if (feature('TEAMMEM') && teamMemPaths!.isTeamMemFile(filePath)) {
    return 'team'
  }
  if (isAutoMemFile(filePath)) {
    return 'personal'
  }
  return null
}

function isAgentMemFile(filePath: string): boolean {
  if (isAutoMemoryEnabled()) {
    return isAnyAgentMemoryPath(filePath)
  }
  return false
}

/**
 * Checks if a file is an AgenC-managed memory file, not a user-managed
 * instruction file such as AGENC.md.
 */
export function isAutoManagedMemoryFile(filePath: string): boolean {
  if (isAutoMemFile(filePath)) {
    return true
  }
  if (feature('TEAMMEM') && teamMemPaths!.isTeamMemFile(filePath)) {
    return true
  }
  if (detectSessionFileType(filePath) !== null) {
    return true
  }
  if (isAgentMemFile(filePath)) {
    return true
  }
  return false
}

/**
 * Check if a directory path is memory-related. Grep/Glob callers pass a
 * directory path rather than a specific file path.
 */
export function isMemoryDirectory(dirPath: string): boolean {
  const normalizedPath = normalize(dirPath)
  const normalizedCmp = toComparable(normalizedPath)

  if (
    isAutoMemoryEnabled() &&
    (normalizedCmp.includes('/agent-memory/') ||
      normalizedCmp.includes('/agent-memory-local/'))
  ) {
    return true
  }

  if (
    feature('TEAMMEM') &&
    teamMemPaths!.isTeamMemoryEnabled() &&
    teamMemPaths!.isTeamMemPath(normalizedPath)
  ) {
    return true
  }

  if (isAutoMemoryEnabled()) {
    if (
      isSameOrChildPath(normalizedPath, getAutoMemPath()) ||
      isSameOrChildPath(normalizedPath, getGlobalMemoryPath())
    ) {
      return true
    }
  }

  const underConfig = isSameOrChildPath(normalizedPath, getAgenCConfigHomeDir())
  const underMemoryBase = isSameOrChildPath(normalizedPath, getMemoryBaseDir())

  if (!underConfig && !underMemoryBase) {
    return false
  }
  if (normalizedCmp.includes('/session-memory/')) {
    return true
  }
  if (underConfig && normalizedCmp.includes('/projects/')) {
    return true
  }
  if (isAutoMemoryEnabled() && normalizedCmp.includes('/memory/')) {
    return true
  }
  return false
}

/**
 * Check if a shell command string targets memory files by extracting absolute
 * path tokens and checking them against memory path predicates.
 */
export function isShellCommandTargetingMemory(command: string): boolean {
  const configDir = getAgenCConfigHomeDir()
  const memoryBase = getMemoryBaseDir()
  const autoMemDir = isAutoMemoryEnabled()
    ? getAutoMemPath().replace(/[/\\]+$/, '')
    : ''

  const commandCmp = toComparable(command)
  const dirs = [configDir, memoryBase, autoMemDir].filter(Boolean)
  const matchesAnyDir = dirs.some(d => {
    if (commandCmp.includes(toComparable(d))) return true
    if (IS_WINDOWS) {
      return commandCmp.includes(windowsPathToPosixPath(d).toLowerCase())
    }
    return false
  })
  if (!matchesAnyDir) {
    return false
  }

  const matches = command.match(/(?:[A-Za-z]:[/\\]|\/)[^\s'"]+/g)
  if (!matches) {
    return false
  }

  for (const match of matches) {
    const cleanPath = match.replace(/[,;|&>]+$/, '')
    const nativePath = IS_WINDOWS
      ? posixPathToWindowsPath(cleanPath)
      : cleanPath
    if (isAutoManagedMemoryFile(nativePath) || isMemoryDirectory(nativePath)) {
      return true
    }
  }

  return false
}

/**
 * Check if a glob/pattern targets auto-managed memory files only.
 */
export function isAutoManagedMemoryPattern(pattern: string): boolean {
  if (detectSessionPatternType(pattern) !== null) {
    return true
  }
  const normalized = pattern.replace(/\\/g, '/')
  if (
    isAutoMemoryEnabled() &&
    (normalized.includes('agent-memory/') ||
      normalized.includes('agent-memory-local/'))
  ) {
    return true
  }
  return false
}

// Provider API key prefix, assembled at runtime so the literal byte sequence
// is not present in the external bundle.
const ANT_KEY_PFX = ['sk', 'ant', 'api'].join('-')

const SECRET_RULES: SecretRule[] = [
  {
    id: 'aws-access-token',
    source: '\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b',
  },
  {
    id: 'gcp-api-key',
    source: '\\b(AIza[\\w-]{35})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'azure-ad-client-secret',
    source:
      '(?:^|[\\\\\'"\\x60\\s>=:(,)])([a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\\\\'"\\x60\\s<),])',
  },
  {
    id: 'digitalocean-pat',
    source: '\\b(dop_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'digitalocean-access-token',
    source: '\\b(doo_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'anthropic-api-key',
    source: `\\b(${ANT_KEY_PFX}03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`,
  },
  {
    id: 'anthropic-admin-api-key',
    source:
      '\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'openai-api-key',
    source:
      '\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'huggingface-access-token',
    source: '\\b(hf_[a-zA-Z]{34})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'github-pat',
    source: 'ghp_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-fine-grained-pat',
    source: 'github_pat_\\w{82}',
  },
  {
    id: 'github-app-token',
    source: '(?:ghu|ghs)_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-oauth',
    source: 'gho_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-refresh-token',
    source: 'ghr_[0-9a-zA-Z]{36}',
  },
  {
    id: 'gitlab-pat',
    source: 'glpat-[\\w-]{20}',
  },
  {
    id: 'gitlab-deploy-token',
    source: 'gldt-[0-9a-zA-Z_\\-]{20}',
  },
  {
    id: 'slack-bot-token',
    source: 'xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*',
  },
  {
    id: 'slack-user-token',
    source: 'xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}',
  },
  {
    id: 'slack-app-token',
    source: 'xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+',
    flags: 'i',
  },
  {
    id: 'twilio-api-key',
    source: 'SK[0-9a-fA-F]{32}',
  },
  {
    id: 'sendgrid-api-token',
    source: '\\b(SG\\.[a-zA-Z0-9=_\\-.]{66})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'npm-access-token',
    source: '\\b(npm_[a-zA-Z0-9]{36})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'pypi-upload-token',
    source: 'pypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}',
  },
  {
    id: 'databricks-api-token',
    source: '\\b(dapi[a-f0-9]{32}(?:-\\d)?)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'hashicorp-tf-api-token',
    source: '[a-zA-Z0-9]{14}\\.atlasv1\\.[a-zA-Z0-9\\-_=]{60,70}',
  },
  {
    id: 'pulumi-api-token',
    source: '\\b(pul-[a-f0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'postman-api-token',
    source:
      '\\b(PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'grafana-api-key',
    source:
      '\\b(eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'grafana-cloud-api-token',
    source: '\\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'grafana-service-account-token',
    source:
      '\\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'sentry-user-token',
    source: '\\b(sntryu_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'sentry-org-token',
    source:
      '\\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}',
  },
  {
    id: 'stripe-access-token',
    source:
      '\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'shopify-access-token',
    source: 'shpat_[a-fA-F0-9]{32}',
  },
  {
    id: 'shopify-shared-secret',
    source: 'shpss_[a-fA-F0-9]{32}',
  },
  {
    id: 'private-key',
    source:
      '-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----',
    flags: 'i',
  },
]

let compiledRules: Array<{ id: string; re: RegExp }> | null = null

function getCompiledRules(): Array<{ id: string; re: RegExp }> {
  compiledRules ??= SECRET_RULES.map(r => ({
    id: r.id,
    re: new RegExp(r.source, r.flags),
  }))
  return compiledRules
}

function ruleIdToLabel(ruleId: string): string {
  const specialCase: Record<string, string> = {
    aws: 'AWS',
    gcp: 'GCP',
    api: 'API',
    pat: 'PAT',
    ad: 'AD',
    tf: 'TF',
    oauth: 'OAuth',
    npm: 'NPM',
    pypi: 'PyPI',
    jwt: 'JWT',
    github: 'GitHub',
    gitlab: 'GitLab',
    openai: 'OpenAI', // branding-scan: allow real provider display name
    digitalocean: 'DigitalOcean',
    huggingface: 'HuggingFace',
    hashicorp: 'HashiCorp',
    sendgrid: 'SendGrid',
  }
  return ruleId
    .split('-')
    .map(part => specialCase[part] ?? capitalize(part))
    .join(' ')
}

/**
 * Scan a string for potential secrets. One match is returned per rule and the
 * matched secret value is intentionally never returned.
 */
export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = []
  const seen = new Set<string>()

  for (const rule of getCompiledRules()) {
    if (seen.has(rule.id)) {
      continue
    }
    if (rule.re.test(content)) {
      seen.add(rule.id)
      matches.push({
        ruleId: rule.id,
        label: ruleIdToLabel(rule.id),
      })
    }
  }

  return matches
}

export function getSecretLabel(ruleId: string): string {
  return ruleIdToLabel(ruleId)
}

let redactRules: RegExp[] | null = null

/**
 * Redact matched secret spans while preserving surrounding boundary text.
 */
export function redactSecrets(content: string): string {
  redactRules ??= SECRET_RULES.map(
    r => new RegExp(r.source, (r.flags ?? '').replace('g', '') + 'g'),
  )
  for (const re of redactRules) {
    content = content.replace(re, (match, g1) =>
      typeof g1 === 'string' ? match.replace(g1, '[REDACTED]') : '[REDACTED]',
    )
  }
  return content
}

/**
 * Check if a file write/edit to a team memory path contains secrets.
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
): string | null {
  if (!feature('TEAMMEM')) {
    return null
  }
  if (!teamMemPaths!.isTeamMemPath(filePath)) {
    return null
  }

  const matches = scanForSecrets(content)
  if (matches.length === 0) {
    return null
  }

  const labels = matches.map(m => m.label).join(', ')
  return (
    `Content contains potential secrets (${labels}) and cannot be written to team memory. ` +
    'Team memory is shared with all repository collaborators. ' +
    'Remove the sensitive content and try again.'
  )
}
