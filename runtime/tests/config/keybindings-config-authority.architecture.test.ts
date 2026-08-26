import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");

function source(name: string): string {
  return readFileSync(resolve(sourceRoot, name), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

describe("canonical keybinding configuration authority", () => {
  test("keeps the retired operator filename at migration/preflight boundaries", () => {
    const allowed = new Set([
      "commands/terminalSetup/terminalSetup.tsx",
      "config/migration.ts",
      "config/retired-input-preflight.ts",
    ]);
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const name = relative(sourceRoot, path);
      if (allowed.has(name)) return [];
      return /keybindings\.json/u.test(readFileSync(path, "utf8"))
        ? [name]
        : [];
    });

    expect(violations).toEqual([]);
    expect(source("commands/terminalSetup/terminalSetup.tsx"))
      .toContain("keybindings.json");
    expect(source("config/migration.ts")).toContain(
      "consumeRetiredKeybindingsJson",
    );
    expect(source("config/retired-input-preflight.ts"))
      .toContain('kind: "user-keybindings-json"');
  });

  test("projects and reloads keybindings only through ConfigStore", () => {
    const loader = source("tui/keybindings/loadUserBindings.ts");
    const setup = source("tui/keybindings/KeybindingProviderSetup.tsx");
    const app = source("tui/components/App.tsx");
    const appServerClient = source("app-server-client/index.ts");
    const cli = source("bin/agenc-main.ts");
    const mcp = source("cli/handlers/mcp.tsx");
    const sessionTypes = source("tui/session-types.ts");
    const tuiMain = source("tui/main.tsx");

    expect(loader).toContain("snapshot?.tui?.keybindings");
    expect(loader).toContain("store.subscribe(");
    expect(loader).not.toMatch(
      /node:fs|chokidar|readFile|writeFile|JSON\.parse|process\.env|getAgenCHome/u,
    );
    expect(setup).toContain("initializeKeybindingSubscription(configStore)");
    expect(app).toContain("<KeybindingSetup configStore={configStore}>");
    expect(app).toContain("const configStore = getTuiConfigStore(props.session)");
    expect(app).not.toContain("props.configStore");
    expect(sessionTypes).not.toContain("ConfigStoreLike");
    expect(sessionTypes).not.toMatch(
      /interface AgenCTuiProps \{[^}]*configStore/su,
    );
    expect(tuiMain).not.toMatch(
      /interface BootTUIOptions \{[^}]*configStore/su,
    );
    expect(appServerClient).not.toMatch(
      /interface AgenCDaemonOnlyTuiContext \{\s*readonly configStore/su,
    );
    expect(cli).not.toMatch(
      /createDeferredDaemonPromptTuiSession\(params: \{[^}]*readonly configStore/su,
    );
    expect(mcp).toContain("<KeybindingSetup configStore={authority}>");
  });

  test("routes /keybindings through the locked canonical writer/editor", () => {
    const command = source("commands/keybindings.ts");
    const registry = source("commands/registry.ts");
    const context = source("commands/config-context.ts");

    expect(command).toContain("mutateCanonicalUserConfigSync(");
    expect(command).toContain("editCanonicalUserConfig({");
    expect(command).toContain("await store.reload()");
    expect(command).toContain("configStoreFromCommandContext(ctx)");
    expect(command).not.toMatch(/node:fs|writeFile|JSON\.stringify/u);
    expect(registry).toContain("keybindingsCommand,");
    expect(context.match(/configStoreFromCommandContext/gu)).toHaveLength(3);
  });

  test("marks nested keymaps as operator-only and leaves managed last", () => {
    const authority = source("config/layer-authority.ts");
    const repository = source("config/repository.ts");

    expect(authority).toContain('["tui", "keybindings"]');
    expect(repository).toContain("OPERATOR_ONLY_CONFIG_PATHS");
    expect(repository).toContain("for (const managed of managedLayers)");
    expect(repository.lastIndexOf("for (const managed of managedLayers)"))
      .toBeGreaterThan(repository.indexOf('syntheticLayer(\n      "cli"'));
  });
});
