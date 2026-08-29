import { z } from 'zod/v4'
import { lazySchema } from '../lazySchema.js'

/**
 * First-layer defense against official marketplace impersonation.
 *
 * This validation blocks direct impersonation attempts like "agenc-official",
 * "agenc-marketplace", etc. Indirect variations (e.g., "my-agenc-marketplace")
 * are not blocked intentionally to avoid false positives on legitimate names.
 * Source org verification provides additional protection at registration/install time.
 */

/**
 * Official marketplace names that are reserved for provider/AgenC official use.
 * These names are allowed ONLY for official marketplaces and blocked for third parties.
 */
export const ALLOWED_OFFICIAL_MARKETPLACE_NAMES = new Set([
  'agenc-code-marketplace',
  'agenc-code-plugins',
  'agenc-plugins-official',
  'agent-skills',
  'life-sciences',
  'knowledge-work-plugins',
])

/**
 * Official marketplaces that should NOT auto-update by default.
 * These are still reserved/allowed names, but opt out of the auto-update
 * default that other official marketplaces receive.
 */
const NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES = new Set(['knowledge-work-plugins'])

/**
 * Check if auto-update is enabled for a marketplace.
 * Uses the stored value if set, otherwise defaults based on whether
 * it's an official provider marketplace (true) or not (false).
 * Official marketplaces in NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES are excluded
 * from the auto-update default.
 *
 * @param marketplaceName - The name of the marketplace
 * @param entry - The marketplace entry (may have autoUpdate set)
 * @returns Whether auto-update is enabled for this marketplace
 */
export function isMarketplaceAutoUpdate(
  marketplaceName: string,
  entry: { autoUpdate?: boolean },
): boolean {
  const normalizedName = marketplaceName.toLowerCase()
  return (
    entry.autoUpdate ??
    (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(normalizedName) &&
      !NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES.has(normalizedName))
  )
}

/**
 * Pattern to detect names that impersonate official provider/AgenC marketplaces.
 *
 * Matches names containing variations like:
 * - "official" combined with "agenc" (e.g., "official-agenc-plugins")
 * - "agenc" combined with "official" (e.g., "agenc-official")
 * - Names starting with "agenc" followed by official-sounding terms
 *   like "marketplace", "plugins" (e.g., "agenc-plugins-v2")
 *
 * The pattern is case-insensitive.
 */
export const BLOCKED_OFFICIAL_NAME_PATTERN =
  /(?:official[^a-z0-9]*agenc|agenc[^a-z0-9]*official|^agenc[^a-z0-9]*(marketplace|plugins|official))/i

/**
 * Pattern to detect non-ASCII characters that could be used for homograph attacks.
 * Marketplace names should only contain ASCII characters to prevent impersonation
 * via lookalike Unicode characters (e.g., Cyrillic 'а' instead of Latin 'a').
 */
const NON_ASCII_PATTERN = /[^\u0020-\u007E]/

/**
 * Check if a marketplace name impersonates an official provider/AgenC marketplace.
 *
 * @param name - The marketplace name to check
 * @returns true if the name is blocked (impersonates official), false if allowed
 */
export function isBlockedOfficialName(name: string): boolean {
  // If it's in the allowed list, it's not blocked
  if (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase())) {
    return false
  }

  // Block names with non-ASCII characters to prevent homograph attacks
  // (e.g., using Cyrillic 'а' to impersonate 'agenc')
  if (NON_ASCII_PATTERN.test(name)) {
    return true
  }

  // Check if it matches the blocked pattern
  return BLOCKED_OFFICIAL_NAME_PATTERN.test(name)
}

/**
 * The official GitHub organization for provider marketplaces.
 * Reserved names must come from this org.
 */
export const OFFICIAL_GITHUB_ORG = 'tetsuo-ai'

/**
 * Validate that a marketplace with a reserved name comes from the official source.
 *
 * Reserved names (in ALLOWED_OFFICIAL_MARKETPLACE_NAMES) can only be used by
 * marketplaces from the official provider GitHub organization.
 *
 * @param name - The marketplace name
 * @param source - The marketplace source configuration
 * @returns An error message if validation fails, or null if valid
 */
export function validateOfficialNameSource(
  name: string,
  source: { source: string; repo?: string; url?: string },
): string | null {
  const normalizedName = name.toLowerCase()

  // Only validate reserved names
  if (!ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(normalizedName)) {
    return null // Not a reserved name, no source validation needed
  }

  // Check for GitHub source type
  if (source.source === 'github') {
    // Verify the repo is from the official org
    const repo = source.repo || ''
    if (!repo.toLowerCase().startsWith(`${OFFICIAL_GITHUB_ORG}/`)) {
      return `The name '${name}' is reserved for official provider marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`
    }
    return null // Valid: reserved name from official GitHub source
  }

  // Check for git URL source type
  if (source.source === 'git' && source.url) {
    // Decide officialness by parsing the host + org path — NOT by substring
    // matching the raw URL. A substring check (url.includes('github.com/org/'))
    // is trivially bypassed by embedding the magic string in the query/fragment/
    // path of an attacker host, e.g. https://evil.com/?u=github.com/tetsuo-ai/x,
    // letting a third-party repo claim a reserved official name.
    const raw = source.url.trim()
    const orgPrefix = `${OFFICIAL_GITHUB_ORG.toLowerCase()}/`
    let isOfficial = false

    if (raw.includes('://')) {
      // URL form (https://, ssh://, git://, …): require host === github.com.
      // Parsed (not substring) so the org path can't be faked in the
      // query/fragment of an attacker host. Handled before the scp branch so a
      // "git@host:path" sequence buried in a URL fragment can't be mistaken for
      // an scp-like address.
      try {
        const u = new URL(raw)
        const host = u.hostname.toLowerCase()
        const path = u.pathname.toLowerCase().replace(/^\/+/, '')
        isOfficial = host === 'github.com' && path.startsWith(orgPrefix)
      } catch {
        isOfficial = false
      }
    } else {
      // SSH scp-like form: git@github.com:tetsuo-ai/repo(.git). Anchored so the
      // host segment must be exactly github.com.
      const sshMatch = raw.match(/^[^@\s]+@([^:\s]+):(.+)$/)
      if (sshMatch) {
        const host = sshMatch[1]!.toLowerCase()
        const path = sshMatch[2]!.toLowerCase().replace(/^\/+/, '')
        isOfficial = host === 'github.com' && path.startsWith(orgPrefix)
      }
    }

    if (isOfficial) {
      return null // Valid: reserved name from official git URL
    }

    return `The name '${name}' is reserved for official provider marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`
  }

  // Reserved names must come from GitHub (either 'github' or 'git' source)
  return `The name '${name}' is reserved for official provider marketplaces and can only be used with GitHub sources from the '${OFFICIAL_GITHUB_ORG}' organization.`
}

/**
 * Schema for relative file paths that must start with './'
 */
const RelativePath = lazySchema(() => z.string().startsWith('./'))

/**
 * Schema for plugin author information
 */
export const PluginAuthorSchema = lazySchema(() =>
  z.object({
    name: z
      .string()
      .min(1, 'Author name cannot be empty')
      .describe('Display name of the plugin author or organization'),
    email: z
      .string()
      .optional()
      .describe('Contact email for support or feedback'),
    url: z
      .string()
      .optional()
      .describe('Website, GitHub profile, or organization URL'),
  }),
)

/**
 * Schema for npm package names
 *
 * Validates npm package names including scoped packages.
 * Prevents path traversal attacks by disallowing '..' and '//'.
 *
 * Valid examples:
 * - "express"
 * - "@babel/core"
 * - "lodash.debounce"
 *
 * Invalid examples:
 * - "../../../etc/passwd"
 * - "package//name"
 */
const NpmPackageNameSchema = lazySchema(() =>
  z
    .string()
    .refine(
      name => !name.includes('..') && !name.includes('//'),
      'Package name cannot contain path traversal patterns',
    )
    .refine(name => {
      // Allow scoped packages (@org/package) and regular packages
      const scopedPackageRegex = /^@[a-z0-9][a-z0-9-._]*\/[a-z0-9][a-z0-9-._]*$/
      const regularPackageRegex = /^[a-z0-9][a-z0-9-._]*$/
      return scopedPackageRegex.test(name) || regularPackageRegex.test(name)
    }, 'Invalid npm package name format'),
)

/**
 * Schema for marketplace source locations
 *
 * Defines various ways to reference marketplace manifests including
 * direct URLs, GitHub repos, git URLs, npm packages, and local paths.
 */
export const MarketplaceSourceSchema = lazySchema(() =>
  z.discriminatedUnion('source', [
    z.object({
      source: z.literal('url'),
      url: z.string().url().describe('Direct URL to marketplace.json file'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Custom HTTP headers (e.g., for authentication)'),
    }).strict(),
    z.object({
      source: z.literal('github'),
      repo: z.string().describe('GitHub repository in owner/repo format'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Directory containing .agenc-plugin/marketplace.json within the repo',
        ),
      sparsePaths: z
        .array(z.string())
        .optional()
        .describe(
          'Directories to include via git sparse-checkout (cone mode). ' +
            'Use for monorepos where the marketplace lives in a subdirectory. ' +
            'Example: [".agenc-plugin", "plugins"]. ' +
            'If omitted, the full repository is cloned.',
        ),
    }).strict(),
    z.object({
      source: z.literal('git'),
      // No .endsWith('.git') here — that's a GitHub/GitLab/Bitbucket
      // convention, not a git requirement. Azure DevOps uses
      // https://dev.azure.com/{org}/{proj}/_git/{repo} with no suffix, and
      // appending .git makes ADO look for a repo literally named {repo}.git
      // (TF401019). AWS CodeCommit also omits the suffix. If the user
      // explicitly wrote source:'git', they know it's a git repo; a typo'd
      // URL fails at `git clone` with a clearer error anyway. (gh-31256)
      url: z.string().describe('Full git repository URL'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Directory containing .agenc-plugin/marketplace.json within the repo',
        ),
      sparsePaths: z
        .array(z.string())
        .optional()
        .describe(
          'Directories to include via git sparse-checkout (cone mode). ' +
            'Use for monorepos where the marketplace lives in a subdirectory. ' +
            'Example: [".agenc-plugin", "plugins"]. ' +
            'If omitted, the full repository is cloned.',
        ),
    }).strict(),
    z.object({
      source: z.literal('file'),
      path: z.string().describe('Local file path to marketplace.json'),
    }).strict(),
    z.object({
      source: z.literal('directory'),
      path: z
        .string()
        .describe('Local directory containing .agenc-plugin/marketplace.json'),
    }).strict(),
    z.object({
      source: z.literal('hostPattern'),
      hostPattern: z
        .string()
        .describe(
          'Regex pattern to match the host/domain extracted from any marketplace source type. ' +
            'For github sources, matches against "github.com". For git sources (SSH or HTTPS), ' +
            'extracts the hostname from the URL. Use in strictKnownMarketplaces to allow all ' +
            'marketplaces from a specific host (e.g., "^github\\.mycompany\\.com$").',
        ),
    }).strict(),
    z.object({
      source: z.literal('pathPattern'),
      pathPattern: z
        .string()
        .describe(
          'Regex pattern matched against the .path field of file and directory sources. ' +
            'Use in strictKnownMarketplaces to allow filesystem-based marketplaces alongside ' +
            'hostPattern restrictions for network sources. Use ".*" to allow all filesystem ' +
            'paths, or a narrower pattern (e.g., "^/opt/approved/") to restrict to specific ' +
            'directories.',
        ),
    }).strict(),
  ]),
)

export const gitSha = lazySchema(() =>
  z
    .string()
    .length(40)
    .regex(
      /^[a-f0-9]{40}$/,
      'Must be a full 40-character lowercase git commit SHA',
    ),
)

/**
 * Schema for plugin source locations
 *
 * Defines various ways to reference and install plugins including
 * local paths, npm packages, Python packages, git URLs, and GitHub repos.
 */
export const PluginSourceSchema = lazySchema(() =>
  z.union([
    RelativePath().describe(
      'Path to the plugin root, relative to the marketplace root (the directory containing .agenc-plugin/, not .agenc-plugin/ itself)',
    ),
    z
      .object({
        source: z.literal('npm'),
        package: NpmPackageNameSchema()
          .or(z.string()) // Allow URLs and local paths as well
          .describe(
            'Package name (or url, or local path, or anything else that can be passed to `npm` as a package)',
          ),
        version: z
          .string()
          .optional()
          .describe('Specific version or version range (e.g., ^1.0.0, ~2.1.0)'),
        registry: z
          .string()
          .url()
          .optional()
          .describe(
            'Custom NPM registry URL (defaults to using system default, likely npmjs.org)',
          ),
      })
      .describe('NPM package as plugin source'),
    z
      .object({
        source: z.literal('pip'),
        package: z
          .string()
          .describe('Python package name as it appears on PyPI'),
        version: z
          .string()
          .optional()
          .describe('Version specifier (e.g., ==1.0.0, >=2.0.0, <3.0.0)'),
        registry: z
          .string()
          .url()
          .optional()
          .describe(
            'Custom PyPI registry URL (defaults to using system default, likely pypi.org)',
          ),
      })
      .describe('Python package as plugin source'),
    z.object({
      source: z.literal('url'),
      // See note on MarketplaceSourceSchema source:'git' re: .endsWith('.git')
      // — dropped to support Azure DevOps / CodeCommit URLs (gh-31256).
      url: z.string().describe('Full git repository URL (https:// or git@)'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      sha: gitSha().optional().describe('Specific commit SHA to use'),
    }),
    z.object({
      source: z.literal('github'),
      repo: z.string().describe('GitHub repository in owner/repo format'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      sha: gitSha().optional().describe('Specific commit SHA to use'),
    }),
    z
      .object({
        source: z.literal('git-subdir'),
        url: z
          .string()
          .describe(
            'Git repository: GitHub owner/repo shorthand, https://, or git@ URL',
          ),
        path: z
          .string()
          .min(1)
          .describe(
            'Subdirectory within the repo containing the plugin (e.g., "tools/agenc-plugin"). ' +
              'Cloned sparsely using partial clone (--filter=tree:0) to minimize bandwidth for monorepos.',
          ),
        ref: z
          .string()
          .optional()
          .describe(
            'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
          ),
        sha: gitSha().optional().describe('Specific commit SHA to use'),
      })
      .describe(
        'Plugin located in a subdirectory of a larger repository (monorepo). ' +
          'Only the specified subdirectory is materialized; the rest of the repo is not downloaded.',
      ),
    // Follow-up (future work) gist
    // Follow-up (future work) single file?
  ]),
)
/**
 * Check if a plugin source is a local path (stored in marketplace directory).
 *
 * Local plugins have their source as a string starting with './' (relative to marketplace).
 * External plugins have their source as an object (npm, pip, git, github, etc.).
 *
 * This function provides a semantic wrapper around the './' prefix check, making
 * the intent clear and centralizing the logic for determining plugin source type.
 *
 * @param source The plugin source value to inspect
 * @returns true if the source is a local path, false if it's an external source
 */
export function isLocalPluginSource(source: PluginSource): source is string {
  return typeof source === 'string' && source.startsWith('./')
}

const DEP_REF_REGEX =
  /^[a-z0-9][-a-z0-9._]*(@[a-z0-9][-a-z0-9._]*)?(@\^[^@]*)?$/i

/**
 * Schema for entries in a plugin's `dependencies` array.
 *
 * Accepts three forms, all normalized to a plain "name" or "name@mkt" string
 * by the transform — downstream code (qualifyDependency, resolveDependencyClosure,
 * verifyAndDemote) never sees versions or objects:
 *
 *   "plugin"                → bare, resolved against declaring plugin's marketplace
 *   "plugin@marketplace"    → qualified
 *   "plugin@mkt@^1.2"       → trailing @^version silently stripped (forwards-compat)
 *   {name, marketplace?, …} → object form, version etc. stripped (forwards-compat)
 *
 * The latter two are permitted-but-ignored so future clients adding version
 * constraints don't cause old clients to fail schema validation and reject
 * the whole plugin. See CC-993 for the eventual version-range design.
 */
export const DependencyRefSchema = lazySchema(() =>
  z.union([
    z
      .string()
      .regex(
        DEP_REF_REGEX,
        'Dependency must be a plugin name, optionally qualified with @marketplace',
      )
      .transform(s => s.replace(/@\^[^@]*$/, '')),
    z
      .object({
        name: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][-a-z0-9._]*$/i),
        marketplace: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][-a-z0-9._]*$/i)
          .optional(),
      })
      .loose()
      .transform(o => (o.marketplace ? `${o.name}@${o.marketplace}` : o.name)),
  ]),
)

// Inferred types from schemas
/**
 * Metadata for plugin command definitions.
 *
 * Commands can be defined with either:
 * - `source`: Path to a markdown file (e.g., "./README.md")
 * - `content`: Inline markdown content string
 *
 * INVARIANT: Exactly one of `source` or `content` must be present.
 * This invariant is enforced by the canonical plugin manifest parser.
 *
 * Validation occurs at plugin manifest parsing. Metadata is assumed valid
 * after passing through createPluginFromPath().
 *
 * @see ../../plugins/manifest-schema.ts for runtime validation rules
 */
export type MarketplaceSource = z.infer<
  ReturnType<typeof MarketplaceSourceSchema>
>
export type PluginAuthor = z.infer<ReturnType<typeof PluginAuthorSchema>>
export type PluginSource = z.infer<ReturnType<typeof PluginSourceSchema>>
export type {
  PluginCommandMetadata as CommandMetadata,
  PluginManifest,
  PluginManifestChannel,
} from '../../plugins/manifest-schema.js'
