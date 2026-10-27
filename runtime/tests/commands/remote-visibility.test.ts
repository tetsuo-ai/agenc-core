import { expect, it } from "vitest";
import { remoteCommand } from "../../src/commands/remote.js";
import { buildDefaultRegistry } from "../../src/commands/registry.js";
import { groupHelpCommands } from "../../src/commands/help.js";
import { listTuiCommandList } from "../../src/commands.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

it.each([false, true])("keeps typed /remote registered but shows help/completion only when owner enabled=%s", enabled => {
  runWithCanonicalSettingsAuthority({ current: () => ({ remote_control: { enabled } }) } as never, () => {
    const registry = buildDefaultRegistry();
    expect(registry.find("remote")).toBe(remoteCommand);
    expect(groupHelpCommands(registry.list()).flatMap(group => group.commands).some(command => command.name === "remote")).toBe(enabled);
    expect(listTuiCommandList(registry).some(command => command.name === "remote")).toBe(enabled);
  });
});

it.each([false, true])("uses the explicit TUI store outside async-local context, enabled=%s", enabled => {
  const registry = buildDefaultRegistry({ surface: "daemon-tui", remoteControlEnabled: () => enabled });
  expect(registry.find("remote")).toBeDefined();
  expect(groupHelpCommands(registry.list()).flatMap(group => group.commands).some(command => command.name === "remote")).toBe(enabled);
  expect(listTuiCommandList(registry).some(command => command.name === "remote")).toBe(enabled);
});
