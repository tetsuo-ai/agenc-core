import type { CliRouteModule } from "./route-types.js";
import { dispatchSkillCommands } from "./route-support.js";

export const routeModule: CliRouteModule = {
  run: ({ parsed, context, stdout, stderr }) =>
    dispatchSkillCommands(parsed, stdout, stderr, context),
};

export default routeModule;
