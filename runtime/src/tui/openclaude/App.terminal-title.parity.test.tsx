import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const APP_SOURCE_PATH = path.resolve(import.meta.dirname, "App.tsx");

function readSource(): string {
  return fs.readFileSync(APP_SOURCE_PATH, "utf8");
}

function extractAnimatedTerminalTitle(source: string): string {
  const start = source.indexOf("function AnimatedTerminalTitle");
  expect(start, "AnimatedTerminalTitle declaration not found").toBeGreaterThan(-1);
  const nextFunction = source.indexOf("\nfunction terminalTitle", start);
  expect(nextFunction, "AnimatedTerminalTitle close not found").toBeGreaterThan(-1);
  return source.slice(start, nextFunction);
}

describe("terminal title parity", () => {
  test("App.tsx imports the upstream terminal title and focus hooks", () => {
    const source = readSource();
    expect(source).toMatch(/\buseTerminalTitle\b/);
    expect(source).toMatch(/\buseTerminalFocus\b/);
  });

  test("AnimatedTerminalTitle writes null when disabled and otherwise prefixes the title", () => {
    const body = extractAnimatedTerminalTitle(readSource());
    expect(body).toMatch(/useTerminalTitle\(\s*disabled\s*\?\s*null/);
    expect(body).toMatch(/noPrefix\s*\?\s*title\s*:\s*`\$\{prefix\}\s+\$\{title\}`/);
  });

  test("AnimatedTerminalTitle keeps upstream animation frames and interval", () => {
    const source = readSource();
    expect(source).toMatch(/TITLE_ANIMATION_INTERVAL_MS\s*=\s*960/);
    expect(source).toMatch(/TITLE_ANIMATION_FRAMES\s*=\s*\["⠂",\s*"⠐"\]/);
    expect(source).toMatch(/TITLE_STATIC_PREFIX\s*=\s*"✳"/);
  });

  test("the live shell renders terminal title before transcript messages", () => {
    const source = readSource();
    const titleIdx = source.indexOf("<AnimatedTerminalTitle");
    const messagesIdx = source.indexOf("<Messages");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(messagesIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeLessThan(messagesIdx);
  });

  test("title animation is suppressed while waiting for permission or local JSX", () => {
    const source = readSource();
    expect(source).toMatch(
      /transcript\.isStreaming\s*&&\s*permissionRequests\.length\s*===\s*0\s*&&\s*toolJSX\s*===\s*null/,
    );
  });

  test("terminal title falls back to AgenC and includes provider plus model when available", () => {
    const source = readSource();
    expect(source).toMatch(/return\s+`AgenC\s+\$\{provider\}\/\$\{model\}`/);
    expect(source).toMatch(/return\s+`AgenC\s+\$\{model\}`/);
    expect(source).toMatch(/return\s+"AgenC"/);
  });
});
