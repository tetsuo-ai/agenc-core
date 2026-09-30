// Synthetic callback validation only; reuse the exact product's hermetic setup.
import { createAgenCVitestConfig } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/vitest.config.ts";
const selected = "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime";
const base = createAgenCVitestConfig();
export default {
  ...base,
  root: selected,
  resolve: { ...base.resolve, alias: [
    { find: /^agenc-selected\/(.*)$/, replacement: selected + "/src/$1" },
    ...base.resolve.alias,
  ] },
  test: { ...base.test,
    include: ["/private/tmp/light-takeover/fair-confirmation/current-cli-observer-v1/fixture-callbacks.test.ts"],
    maxWorkers: 1, fileParallelism: false,
  },
};
