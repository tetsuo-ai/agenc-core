export const HOSTED_NEOVIM_TARGETS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
]);

// Do not add win-x64 back. GitHub's hosted Windows ConPTY path has produced
// nondeterministic synthetic-input failures on unrelated changes. Windows
// keeps the real Neovim lifecycle and provider contracts in platform-tests.

export const HOSTED_NEOVIM_SCENARIOS = Object.freeze([
  "130-workbench-buffer-neovim-platform-gate.mjs",
  "131-workbench-buffer-neovim-platform-kill-cleanup.mjs",
]);

export const PLATFORM_SCENARIO_REGISTRY = Object.freeze(
  Object.fromEntries(
    HOSTED_NEOVIM_TARGETS.map((target) => [
      target,
      HOSTED_NEOVIM_SCENARIOS,
    ]),
  ),
);

export function selectPlatformScenarios(discoveredNames, platform) {
  const selected = PLATFORM_SCENARIO_REGISTRY[platform];
  if (selected === undefined) {
    throw new Error(
      `unsupported TUI E2E platform ${JSON.stringify(platform)}; expected one of ${
        HOSTED_NEOVIM_TARGETS.join(", ")
      }`,
    );
  }
  const discovered = new Set(discoveredNames);
  const missing = selected.filter((name) => !discovered.has(name));
  if (missing.length > 0) {
    throw new Error(
      `TUI E2E platform ${platform} is missing required scenario(s): ${
        missing.join(", ")
      }`,
    );
  }
  return [...selected];
}
