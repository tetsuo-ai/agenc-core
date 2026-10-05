import { describe, expect, it } from "vitest";
import { parseAgenCDaemonCliArgs } from "../../src/app-server/daemon-control.js";
import { parseAgenCRemoteCliArgs } from "../../src/bin/remote-cli.js";
import { parseAgenCDaemonProxyCliArgs } from "../../src/bin/daemon-proxy-cli.js";
import { parseAgenCAgentCliArgs } from "../../src/app-server/agent-cli.js";
import { parseAgenCAuthCliArgs } from "../../src/bin/auth-cli.js";
import { parseOpenAiAuthCliArgs } from "../../src/bin/openai-auth-cli.js";
import { parseGrokAuthCliArgs } from "../../src/bin/grok-auth-cli.js";
import { parseOpenAiModelsCliArgs } from "../../src/bin/openai-models-cli.js";
import { parseKimiModelsCliArgs } from "../../src/bin/kimi-models-cli.js";
import { parseAgenCMcpCliArgs } from "../../src/bin/mcp-cli-args.js";
import { parseAgenCDoctorCliArgs } from "../../src/bin/doctor-cli-args.js";
import { parseAgenCOnboardCliArgs } from "../../src/bin/onboard-cli.js";
import { parseAgenCSecurityCliArgs } from "../../src/bin/security-cli.js";
import { parseAgenCUpdateCliArgs } from "../../src/bin/update-cli.js";
import { parseAgenCGatewayCliArgs } from "../../src/bin/gateway-cli.js";
import { parseAgenCBudgetCliArgs } from "../../src/bin/budget-cli.js";
import { parseAgenCRunCliArgs } from "../../src/bin/run-cli.js";
import { parseAgenCInitCliArgs } from "../../src/bin/init-cli.js";
import { parseAgenCProvidersCliArgs } from "../../src/bin/providers-cli.js";
import { parseAgenCConfigCliArgs } from "../../src/bin/config-cli.js";
import { parseAgenCPluginCliArgs } from "../../src/plugins/cli/pluginCliCommands.js";
import { parseAgenCSkillsCliArgs } from "../../src/skills/skills-cli-args.js";
import { parseAgenCPermissionsCliArgs } from "../../src/permissions/permission-cli.js";
import { parseAgenCStateCliArgs } from "../../src/bin/state-cli.js";
import { parseAgenCTrajectoriesCliArgs } from "../../src/bin/trajectories-cli-args.js";

// These are the canonical command parsers ahead of the default route in main().
// A leading print flag must remain prompt routing, even if a subcommand follows.
const commandParsers = [
  parseAgenCDaemonCliArgs,
  parseAgenCRemoteCliArgs,
  parseAgenCDaemonProxyCliArgs,
  parseAgenCAgentCliArgs,
  parseAgenCAuthCliArgs,
  parseOpenAiAuthCliArgs,
  parseGrokAuthCliArgs,
  parseOpenAiModelsCliArgs,
  parseKimiModelsCliArgs,
  parseAgenCMcpCliArgs,
  parseAgenCDoctorCliArgs,
  parseAgenCOnboardCliArgs,
  parseAgenCSecurityCliArgs,
  parseAgenCUpdateCliArgs,
  parseAgenCGatewayCliArgs,
  parseAgenCBudgetCliArgs,
  parseAgenCRunCliArgs,
  parseAgenCInitCliArgs,
  parseAgenCProvidersCliArgs,
  parseAgenCConfigCliArgs,
  parseAgenCPluginCliArgs,
  parseAgenCSkillsCliArgs,
  parseAgenCPermissionsCliArgs,
  parseAgenCStateCliArgs,
  parseAgenCTrajectoriesCliArgs,
];

describe("explicit print keeps the canonical command boundary", () => {
  it.each(commandParsers)("does not steal a command from %s", (parse) => {
    for (const print of ["-p", "--print"]) {
      for (const word of ["init", "daemon", "proxy", "remote", "agent", "auth", "login", "mcp", "doctor", "onboard", "security", "update", "gateway", "budget", "run", "providers", "config", "plugin", "skills", "permissions", "state", "trajectories"]) {
        expect(parse([print, word, "--help"])).toBeNull();
        expect(parse([print, "--light", word])).toBeNull();
      }
    }
  });
});
