# AgenC Core Installer — get.agenc.ag

Static installer page for **agenc-core** (the `agenc` CLI) in the AgenC b/w
design system (Archivo + IBM Plex Mono, 1px #0a0a0a borders, offset shadows,
grid background).

## Files

- `public/index.html` — the whole page: markup, CSS, and vanilla JS (no build
  step or dependencies)
- `public/assets/agenc-logo.svg` — brand mark (favicon + nav)
- `public/assets/agenc-wordmark.svg` — wordmark (nav + hero, tinted black via
  `filter: brightness(0)`)
- `public/robots.txt` — crawler policy
- `vercel.json` — production security headers and stable release redirects

Fonts load from Google Fonts (Archivo, IBM Plex Mono). Self-host them if the
page must respect a strict CSP (`font-src 'self'`).

## Behavior

- Single install command: `curl -fsSL https://get.agenc.ag/install.sh | sh`
- Click-to-copy with Clipboard API + `execCommand` fallback, "COPIED ✓" feedback
- Dark mode: toggle in the nav, respects `prefers-color-scheme`, persisted in
  `localStorage` (`agenc-theme`), smooth transitions (CSS variables)
- First-run block: `agenc onboard`, `agenc doctor && agenc security audit`
- Links: quickstart docs, GitHub repo, agenc.ag
- Fully responsive ≤768px

## Deploy

Deploy this directory as the linked Vercel project. Vercel serves `public/` at
the site root and applies the four temporary release-asset redirects from
`vercel.json`.
