import { describe, expect, test } from "vitest";
import { abbreviateHomePaths } from "../../src/utils/home-path-display.js";

describe("home paths in presentation text", () => {
  test("abbreviates quoted commands, diagnostics and multiple paths", () => {
    const text = 'ls "/home/demo-user/.agenc/memory/MEMORY.md"; cat /home/demo-user/a.md\nMissing: /home/demo-user';
    expect(abbreviateHomePaths(text, "/home/demo-user/"))
      .toBe('ls "~/.agenc/memory/MEMORY.md"; cat ~/a.md\nMissing: ~');
  });
  test("preserves other users, path suffixes and paths outside HOME", () => {
    const text = '/home/demo-user2/a /backup/home/demo-user/a /work/a ../a';
    expect(abbreviateHomePaths(text, "/home/demo-user")).toBe(text);
    expect(abbreviateHomePaths(text, "/")).toBe(text);
    expect(abbreviateHomePaths(text, "")).toBe(text);
  });
  test("handles spaces and regex metacharacters literally", () => {
    expect(abbreviateHomePaths('cat "/Users/Demo (1)/a"', "/Users/Demo (1)"))
      .toBe('cat "~/a"');
  });
  test("handles Windows separators and case without matching sibling users", () => {
    expect(abbreviateHomePaths('Read C:\\Users\\Demo\\memory\\MEMORY.md and c:/users/demo/a', 'C:\\Users\\Demo'))
      .toBe('Read ~\\memory\\MEMORY.md and ~/a');
    expect(abbreviateHomePaths('C:\\Users\\Demo2\\a', 'C:\\Users\\Demo')).toBe('C:\\Users\\Demo2\\a');
  });
});
