import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ loaded: 0, foreground: vi.fn(async () => 17) }));
vi.mock("../../src/app-server/daemon-cli.js", () => {
  runtime.loaded += 1;
  return { runAgenCDaemonForeground: runtime.foreground };
});
import { runAgenCDaemonCli, type AgenCDaemonCliHost } from "../../src/app-server/daemon-control.js";

function staticLocalGraph(entry: string, readSource = (file: string) => readFileSync(file, "utf8")): Set<string> {
  const seen = new Set<string>();
  function visit(file: string): void {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        const bindings = clause?.namedBindings;
        if (!clause?.name && bindings && ts.isNamedImports(bindings) &&
            bindings.elements.every(element => element.isTypeOnly)) continue;
      } else if (statement.isTypeOnly || (statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.every(element => element.isTypeOnly))) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".") && !specifier.startsWith("src/") && specifier !== "bun:bundle") continue;
      const base = specifier === "bun:bundle" ? resolve("src/build/feature.ts") :
        specifier.startsWith("src/") ? resolve(specifier) : resolve(dirname(file), specifier);
      const target = [base.replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts").replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"), base, base + ".ts", base + ".tsx", base + "/index.ts"].find(existsSync);
      if (!target) throw new Error(`Unresolved local static import: ${file} -> ${specifier}`);
      visit(target);
    }
  }
  visit(entry);
  return seen;
}

describe("daemon control foreground boundary", () => {
  it.each(["app-server/daemon-control.ts", "app-server/daemon-provisional-start.ts", "bin/print-cli-main.ts"])(
    "keeps %s outside the project database implementation graph", entry => {
      const graph = staticLocalGraph(resolve("src", entry));
      expect(graph.has(resolve("src/state/database-paths.ts"))).toBe(true);
      for (const target of ["state/sqlite-driver.ts", "state/migrations/index.ts",
        "state/fresh-state-schema.ts", "session/session-store.ts"]) {
        expect(graph.has(resolve("src", target)), target).toBe(false);
      }
      expect(graph.has(resolve("src/utils/sqlite-lock.ts"))).toBe(true);
    },
  );

  it("detects a forbidden driver import added behind the discovery leaf", () => {
    const leaf = resolve("src/state/database-paths.ts");
    const graph = staticLocalGraph(resolve("src/app-server/daemon-control.ts"), file =>
      readFileSync(file, "utf8") + (file === leaf ? '\nimport "./sqlite-driver.js";\n' : ""));
    expect(graph.has(resolve("src/state/sqlite-driver.ts"))).toBe(true);
    expect(graph.has(resolve("src/session/session-store.ts"))).toBe(true);
  });

  it("keeps configured MCP decisions outside the server implementation graph", () => {
    const graph = staticLocalGraph(resolve("src/mcp/server/configured-start.ts"));
    for (const file of ["mcp/server/start.ts", "mcp/server/content-providers.ts",
      "memory/index.ts", "mcp-server/framework.ts", "mcp-server/http-sse.ts", "mcp-server/stdio.ts"]) {
      expect(graph.has(resolve("src", file)), file).toBe(false);
    }
    const file = resolve("src/app-server/daemon-cli.ts");
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration);
    const serverEdges = imports.filter(statement => ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "../mcp/server/start.js");
    expect(serverEdges).toHaveLength(1);
    expect(serverEdges[0]?.importClause?.isTypeOnly).toBe(true);
    expect(imports.some(statement => ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "../mcp/server/configured-start.js" &&
      !statement.importClause?.isTypeOnly)).toBe(true);
  });

  it("has no static local path to foreground services", () => {
    const graph = staticLocalGraph(resolve("src/app-server/daemon-control.ts"));
    for (const target of ["app-server/daemon-cli.ts", "app-server/agent-lifecycle.ts",
      "app-server/background-agent-runner.ts", "session/run-turn.ts", "mcp/server/start.ts"]) {
      expect(graph.has(resolve("src", target)), target).toBe(false);
    }
  });

  it("keeps the autostart path outside the foreground graph", () => {
    const graph = staticLocalGraph(resolve("src/app-server/daemon-autostart.ts"));
    expect(graph.has(resolve("src/app-server/daemon-cli.ts"))).toBe(false);
    expect(graph.has(resolve("src/mcp/server/start.ts"))).toBe(false);
  });

  it("keeps the CLI static graph outside the foreground facade", () => {
    const graph = staticLocalGraph(resolve("src/bin/agenc-main.ts"));
    expect(graph.has(resolve("src/app-server/daemon-cli.ts"))).toBe(false);
    expect(graph.has(resolve("src/bin/local-turn-runtime.ts"))).toBe(false);
    expect(graph.has(resolve("src/session/run-turn.ts"))).toBe(false);
    for (const target of ["bin/mcp-cli.ts", "bin/doctor-cli.ts", "bin/trajectories-cli.ts",
      "skills/skills-cli.ts", "bin/slash.ts", "utils/gracefulShutdown.ts"]) {
      expect(graph.has(resolve("src", target)), target).toBe(false);
    }
  });

  it("loads foreground only on run and preserves the exact host capability", async () => {
    const host = {} as AgenCDaemonCliHost;
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    expect(runtime.loaded).toBe(0);
    expect(await runAgenCDaemonCli({ kind: "help", text: "test" }, { host, io })).toBe(0);
    expect(runtime.loaded).toBe(0);
    const beforeDaemonReady = vi.fn();
    expect(await runAgenCDaemonCli({ kind: "command", action: "run" }, {
      host, io, beforeDaemonReady, enterDaemonHome: true,
    })).toBe(17);
    expect(runtime.loaded).toBe(1);
    expect(runtime.foreground).toHaveBeenCalledExactlyOnceWith(host, io,
      expect.objectContaining({ beforeDaemonReady, enterDaemonHome: true }));
  });
});
