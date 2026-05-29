/**
 * inc-5046: fetch the official marketplace from a GCS mirror instead of
 * git-cloning GitHub on every startup.
 *
 * Backend (anthropic#317037) publishes a marketplace-only zip alongside the
 * titanium squashfs, keyed by base repo SHA. This module fetches the `latest`
 * pointer, compares against a local sentinel, and downloads+extracts the zip
 * when there's a new SHA. Callers decide fallback behavior on failure.
 */

import axios from 'axios'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { waitForScrollIdle } from '../../bootstrap/state.js'
import { logForDebugging } from 'src/utils/debug.js'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { errorMessage } from '../errors.js'

// CDN-fronted domain for the public GCS bucket (same bucket the native
// binary ships from — nativeInstaller/download.ts:24 uses the raw GCS URL).
// `{sha}.zip` is content-addressed so CDN can cache it indefinitely;
// `latest` has Cache-Control: max-age=300 so CDN staleness is bounded.
// Backend (anthropic#317037) populates this prefix.
const GCS_BASE =
  'https://agenc.tech/agenc-code-releases/plugins/agenc-plugins-official'

// Zip arc paths are seed-dir-relative (marketplaces/agenc-plugins-official/…)
// so the titanium seed machinery can use the same zip. Strip this prefix when
// extracting for a laptop install.
const ARC_PREFIX = 'marketplaces/agenc-plugins-official/'

/**
 * Fetch the official marketplace from GCS and extract to installLocation.
 * Idempotent — checks a `.gcs-sha` sentinel before downloading the ~3.5MB zip.
 *
 * @param installLocation where to extract (must be inside marketplacesCacheDir)
 * @param marketplacesCacheDir the plugins marketplace cache root — passed in
 *   by callers (rather than imported from pluginDirectories) to break a
 *   circular-dep edge through marketplaceManager
 * @returns the fetched SHA on success (including no-op), null on any failure
 *   (network, 404, zip parse). Caller decides whether to fall through to git.
 */
export async function fetchOfficialMarketplaceFromGcs(
  installLocation: string,
  marketplacesCacheDir: string,
): Promise<string | null> {
  // Defense in depth: this function does `rm(installLocation, {recursive})`
  // during the atomic swap. A corrupted known_marketplaces.json (gh-32793 —
  // Windows path read on WSL, literal tilde, manual edit) could point at the
  // user's project. Refuse any path outside the marketplaces cache dir.
  // Same guard as refreshMarketplace() at marketplaceManager.ts:~2392 but
  // inside the function so ALL callers are covered.
  const cacheDir = resolve(marketplacesCacheDir)
  const resolvedLoc = resolve(installLocation)
  if (resolvedLoc !== cacheDir && !resolvedLoc.startsWith(cacheDir + sep)) {
    logForDebugging(
      `fetchOfficialMarketplaceFromGcs: refusing path outside cache dir: ${installLocation}`,
      { level: 'error' },
    )
    return null
  }

  // Network + zip extraction competes for the event loop with scroll frames.
  // This is a fire-and-forget startup call — delaying by a few hundred ms
  // until scroll settles is invisible to the user.
  await waitForScrollIdle()

  let sha: string | undefined

  try {
    // 1. Latest pointer — ~40 bytes, backend sets Cache-Control: no-cache,
    //    max-age=300. Cheap enough to hit every startup.
    const latest = await axios.get(`${GCS_BASE}/latest`, {
      responseType: 'text',
      timeout: 10_000,
    })
    sha = String(latest.data).trim()
    if (!sha) {
      // Empty /latest body — backend misconfigured. Bail (null), don't
      // lock into a permanently-broken empty-sentinel state.
      throw new Error('latest pointer returned empty body')
    }

    // 2. Sentinel check — `.gcs-sha` at the install root holds the last
    //    extracted SHA. Matching means we already have this content.
    const sentinelPath = join(installLocation, '.gcs-sha')
    const currentSha = await readFile(sentinelPath, 'utf8').then(
      s => s.trim(),
      () => null, // ENOENT — first fetch, proceed to download
    )
    if (currentSha === sha) {
      return sha
    }

    // 3. Download zip and extract to a staging dir, then atomic-swap into
    //    place. Crash mid-extract leaves a .staging dir (next run rm's it)
    //    rather than a half-written installLocation.
    const zipResp = await axios.get(`${GCS_BASE}/${sha}.zip`, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    })
    const zipBuf = Buffer.from(zipResp.data)
    const files = await unzipFile(zipBuf)
    // fflate doesn't surface external_attr, so parse the central directory
    // ourselves to recover exec bits. Without this, hooks/scripts extract as
    // 0644 and `sh -c "/path/script.sh"` (hooks.ts:~1002) fails with EACCES
    // on Unix. Git-clone preserves +x natively; this keeps GCS at parity.
    const modes = parseZipModes(zipBuf)

    const staging = `${installLocation}.staging`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    for (const [arcPath, data] of Object.entries(files)) {
      if (!arcPath.startsWith(ARC_PREFIX)) continue
      const rel = arcPath.slice(ARC_PREFIX.length)
      if (!rel || rel.endsWith('/')) continue // prefix dir entry or subdir entry
      const dest = join(staging, rel)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, data)
      const mode = modes[arcPath]
      if (mode && mode & 0o111) {
        // Only chmod when an exec bit is set — skip plain files to save syscalls.
        // Swallow EPERM/ENOTSUP (NFS root_squash, some FUSE mounts) — losing +x
        // is the pre-PR behavior and better than aborting mid-extraction.
        await chmod(dest, mode & 0o777).catch(() => {})
      }
    }
    await writeFile(join(staging, '.gcs-sha'), sha)

    // Atomic swap: rm old, rename staging. Brief window where installLocation
    // doesn't exist — acceptable for a background refresh (caller retries next
    // startup if it crashes here).
    await rm(installLocation, { recursive: true, force: true })
    await rename(staging, installLocation)

    return sha
  } catch (e) {
    logForDebugging(
      `Official marketplace GCS fetch failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return null
  }
}
