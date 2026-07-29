import { createAgenCVitestConfig } from './vitest.config.ts';

const base = createAgenCVitestConfig('neovim');

// Cross-platform hosted Neovim coverage intentionally lives outside the
// default test discovery tree. This exact allowlist is run on every required
// Linux, Darwin, and Windows architecture with zero skips.
export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'tests/tui/workbench/buffer-neovim-provider.contract.test.ts',
      'platform-tests/neovim-process-tree.real.test.ts',
      'platform-tests/neovim-platform-gate.contract.test.ts',
    ],
  },
};
