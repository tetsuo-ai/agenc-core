import type { CliRouteDescriptor } from "./route-types.js";

const routeSkill: CliRouteDescriptor = {
  name: "skill",
  matches(parsed) {
    return parsed.positional[0] === "skill";
  },
  load: () =>
    import("./route-skill.impl.js").then((module) => module.routeModule),
};

export default routeSkill;
