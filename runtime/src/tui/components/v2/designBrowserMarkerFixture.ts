export type BrowserMarkerFixtureEntry = {
  readonly marker: string
  readonly row: number
  readonly column: number
  readonly family?: 'accent' | 'worker' | 'success' | 'error'
}

export const BROWSER_MARKER_FIXTURE = {
  '01a': [
    { marker: 'agenc.', row: 3, column: 20 },
    { marker: 'a netrunner with hands on every file', row: 4, column: 20 },
    { marker: 'default model', row: 9, column: 35 },
    { marker: 'runtime coverage', row: 18, column: 26 },
  ],
  '01b': [
    { marker: 'checkpointed plan', row: 12, column: 26 },
    { marker: '#47', row: 10, column: 24 },
    { marker: 'task', row: 0, column: 120 },
    { marker: 'read programs/swap/src/lib.rs', row: 14, column: 30 },
  ],
  '02a': [
    { marker: '/claim', row: 16, column: 9, family: 'accent' },
    { marker: '/delegate', row: 18, column: 9 },
    { marker: '/model', row: 31, column: 9 },
    { marker: '/proof', row: 19, column: 9 },
  ],
  '02b': [
    { marker: '/delegate', row: 31, column: 9, family: 'accent' },
    { marker: '/diff', row: 33, column: 9 },
    { marker: 'matches · 2', row: 30, column: 6 },
    { marker: 'show the current working diff', row: 33, column: 47 },
  ],
  '03a': [
    { marker: 'plan', row: 4, column: 21 },
    { marker: 'guard', row: 16, column: 28 },
    { marker: 'streaming', row: 33, column: 6, family: 'accent' },
    { marker: 'worker/zk-prover', row: 9, column: 102, family: 'worker' },
  ],
  '03b': [
    { marker: 'swap_v2', row: 19, column: 31 },
    { marker: 'Read (programs/swap/src/lib.rs:114-130)', row: 16, column: 21 },
    { marker: 'Grep (pattern: "token::transfer", path: "programs/swap/src"', row: 13, column: 21 },
    { marker: 'token::transfer(cpi_ctx, amount_in)', row: 19, column: 44 },
  ],
  '04a': [
    { marker: 'read', row: 8, column: 20 },
    { marker: 'grep', row: 14, column: 20 },
    { marker: 'bash', row: 19, column: 20, family: 'worker' },
    { marker: 'SlippageExceeded', row: 16, column: 27 },
  ],
  '04b': [
    { marker: 'DIFF', row: 11, column: 23 },
    { marker: 'swap_v2', row: 13, column: 32, family: 'accent' },
    { marker: 'max_slip', row: 16, column: 32 },
    { marker: 'programs/swap/src/math.rs', row: 6, column: 27 },
  ],
  '05a': [
    { marker: 'needs approval', row: 7, column: 37, family: 'worker' },
    { marker: 'localnet', row: 4, column: 21 },
    { marker: 'approve', row: 19, column: 23 },
    { marker: 'localhost:8899', row: 15, column: 47 },
  ],
  '05b': [
    { marker: 'high-risk approval', row: 7, column: 37, family: 'error' },
    { marker: 'mainnet-beta', row: 11, column: 23 },
    { marker: "type 'yes' to send", row: 21, column: 23 },
    { marker: 'api.mainnet-beta.solana.com', row: 11, column: 23 },
  ],
  '06a': [
    { marker: 'slashing event', row: 13, column: 23, family: 'error' },
    { marker: 'public-input mismatch', row: 9, column: 22, family: 'error' },
    { marker: 'worker', row: 3, column: 31 },
    { marker: 'max_slip = 500 bps', row: 14, column: 78 },
  ],
  '06b': [
    { marker: 'exit 101', row: 4, column: 22, family: 'error' },
    { marker: 'recovery plan', row: 33, column: 23, family: 'accent' },
    { marker: 'apply?', row: 39, column: 21 },
    { marker: 'swap_high_slippage_aborts', row: 34, column: 52 },
  ],
  '07a': [
    { marker: 'task #47 settled', row: 10, column: 24, family: 'success' },
    { marker: 'escrow', row: 7, column: 22 },
    { marker: 'proof', row: 3, column: 20, family: 'accent' },
    { marker: 'slippage_bps', row: 3, column: 28 },
  ],
  '07b': [
    { marker: 'self-review', row: 7, column: 21 },
    { marker: 'delegation', row: 24, column: 51 },
    { marker: 'next task', row: 33, column: 128 },
    { marker: 'WENT WELL', row: 9, column: 23, family: 'success' },
  ],
  '08a': [
    { marker: 'programs/swap', row: 20, column: 9 },
    { marker: 'select', row: 18, column: 90 },
    { marker: '@pool', row: 35, column: 4 },
    { marker: 'pool.rs', row: 4, column: 61 },
  ],
  '08b': [
    { marker: 'anchor build', row: 35, column: 4 },
    { marker: 'shell mode', row: 33, column: 4, family: 'worker' },
    { marker: 'git status -sb', row: 4, column: 21 },
    { marker: 'unused import', row: 22, column: 23 },
  ],
  '09': [
    { marker: 'slippage', row: 4, column: 21 },
    { marker: 'guard', row: 8, column: 21 },
    { marker: 'math/slip.rs', row: 11, column: 23 },
    { marker: 'MIN_SLIPPAGE_BPS', row: 26, column: 23, family: 'accent' },
  ],
  '10': [
    { marker: 'context', row: 5, column: 12, family: 'accent' },
    { marker: '22,841', row: 5, column: 21 },
    { marker: '200,000', row: 5, column: 29 },
    { marker: '11.4% used', row: 5, column: 47 },
  ],
  '11': [
    { marker: '/model', row: 4, column: 21 },
    { marker: 'model selection', row: 5, column: 10 },
    { marker: 'haiku-4.5', row: 5, column: 40 },
    { marker: '$4.00', row: 8, column: 75 },
  ],
  '12': [
    { marker: '/skills', row: 4, column: 21 },
    { marker: 'skills', row: 4, column: 21 },
    { marker: 'solana-anchor', row: 8, column: 13 },
    { marker: '"anchor-lang"', row: 17, column: 91 },
  ],
  '13': [
    { marker: '/mcp', row: 4, column: 21 },
    { marker: 'mcp servers', row: 5, column: 10 },
    { marker: 'solana.account', row: 9, column: 85 },
    { marker: 'auth req', row: 29, column: 24 },
  ],
  '14': [
    { marker: '/hooks', row: 4, column: 21 },
    { marker: 'hooks', row: 4, column: 21 },
    { marker: 'pre-tool/edit', row: 8, column: 13 },
    { marker: 'post-tool/edit', row: 11, column: 14 },
  ],
  '15': [
    { marker: '/plugins', row: 4, column: 21 },
    { marker: 'plugins', row: 4, column: 21 },
    { marker: 'agenc-core', row: 8, column: 13 },
    { marker: 'anchor-toolkit', row: 10, column: 13 },
  ],
  '16': [
    { marker: '/agents', row: 4, column: 21 },
    { marker: 'agents', row: 4, column: 21 },
    { marker: 'name · Role', row: 7, column: 13 },
    { marker: 'system prompt', row: 18, column: 82 },
  ],
  '17': [
    { marker: '/permissions', row: 4, column: 21 },
    { marker: 'permissions', row: 4, column: 21 },
    { marker: 'allow', row: 8, column: 44 },
    { marker: 'bypassPermissions', row: 14, column: 13 },
  ],
  '18': [
    { marker: '/memory', row: 4, column: 21 },
    { marker: 'memory', row: 4, column: 21 },
    { marker: '# AGENC.md', row: 8, column: 82 },
    { marker: 'AGENC.md', row: 9, column: 13 },
  ],
  '19a': [
    { marker: 'background tasks', row: 5, column: 10 },
    { marker: 'running', row: 5, column: 28 },
    { marker: 'remote', row: 8, column: 14 },
    { marker: 'verify slip_within invariant', row: 8, column: 27 },
  ],
  '19b': [
    { marker: 'plan mode', row: 3, column: 20 },
    { marker: 'proposal', row: 14, column: 20 },
    { marker: 'accept & execute', row: 33, column: 91 },
    { marker: 'read-only', row: 3, column: 33 },
  ],
  '19c': [
    { marker: 'accept', row: 0, column: 106 },
    { marker: 'bypass', row: 23, column: 43 },
    { marker: 'shift+tab', row: 25, column: 38 },
    { marker: 'permission mode', row: 14, column: 38 },
  ],
} as const satisfies Record<string, readonly BrowserMarkerFixtureEntry[]>
