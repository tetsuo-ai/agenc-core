import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnvSnapshot } from "../../src/config/env.js";
import { resolveHomeContext } from "../../src/config/home.js";
import { RuntimeStateRepository } from "../../src/config/runtime-state-repository.js";
import { ConfigStore } from "../../src/config/store.js";
import type { ProviderAuthReadContext } from "../../src/utils/auth.js";

const TEST_AUTH_HOME = join(tmpdir(), "agenc-tui-auth-authority-test-home");

export const TEST_REMOTE_AUTH_ENVIRONMENT: EnvSnapshot = Object.freeze({
  AGENC_HOME: TEST_AUTH_HOME,
});

export const TEST_REMOTE_AUTH_SESSION_CONTEXT: ProviderAuthReadContext =
  Object.freeze({
    home: resolveHomeContext(TEST_REMOTE_AUTH_ENVIRONMENT, {
      platformHome: tmpdir(),
    }),
    environment: TEST_REMOTE_AUTH_ENVIRONMENT,
    provider: "anthropic",
  });

export const TEST_RUNTIME_STATE_REPOSITORY = new RuntimeStateRepository(
  TEST_REMOTE_AUTH_SESSION_CONTEXT.home,
  { storage: "memory" },
);

export const TEST_SETTINGS_AUTHORITY = new ConfigStore({
  cwd: tmpdir(),
  env: TEST_REMOTE_AUTH_ENVIRONMENT,
  home: TEST_AUTH_HOME,
  projectTrusted: false,
  stateRepository: TEST_RUNTIME_STATE_REPOSITORY,
});
