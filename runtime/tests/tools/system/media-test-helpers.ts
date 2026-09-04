import { join } from "node:path";

import { resolveHomeContext } from "../../../src/config/home.js";
import {
  createModelFacingTools,
  type ModelFacingToolOptions,
} from "../../../src/bin/model-facing-tools.js";

export function mediaTestHome(workspaceRoot: string) {
  return resolveHomeContext(
    {
      AGENC_HOME: join(workspaceRoot, ".agenc-test-home"),
      HOME: workspaceRoot,
    },
    { platformHome: workspaceRoot },
  );
}

export function isModelFacingToolRegistered(
  name: string,
  options: ModelFacingToolOptions,
): boolean {
  return createModelFacingTools(options).some((tool) => tool.name === name);
}
