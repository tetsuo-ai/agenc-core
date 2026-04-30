import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("App OpenClaude shell parity", () => {
  test("the live App shell owns transcript, composer, overlays, and status", () => {
    const app = source("App.tsx");

    expect(app).toMatch(/from "\.\/transcript\/MessageList\.js"/u);
    expect(app).toMatch(/from "\.\/composer\/Composer\.js"/u);
    expect(app).toMatch(/from "\.\/permissions\/InteractiveHandler\.js"/u);
    expect(app).toMatch(/from "\.\/cockpit\/StatusNotices\.js"/u);
    expect(app).toMatch(/<MessageList/u);
    expect(app).toMatch(/<Composer/u);
    expect(app).not.toMatch(/statusLine:\s*\{/u);
    expect(app).not.toMatch(/<StatusLineConfig/u);
    expect(app).not.toMatch(/import\s+\{[^}]*StatusLineConfig/u);
  });

  test("the REPL shell also avoids the old status footer route", () => {
    const repl = source("screens/REPL.tsx");

    expect(repl).toMatch(/<Composer/u);
    expect(repl).not.toMatch(/statusLine:\s*\{/u);
    expect(repl).not.toMatch(/<StatusLineConfig/u);
    expect(repl).not.toMatch(/import\s+\{[^}]*StatusLineConfig/u);
  });

  test("the shell does not branch to a separate yolo component", () => {
    const app = source("App.tsx");
    const main = source("main.tsx");

    expect(app).not.toMatch(/Yolo[A-Z][A-Za-z]*Shell/u);
    expect(main).not.toMatch(/Yolo[A-Z][A-Za-z]*Shell/u);
  });
});
