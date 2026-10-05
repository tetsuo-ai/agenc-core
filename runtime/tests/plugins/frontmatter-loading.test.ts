import { beforeEach, expect, it, vi } from "vitest";

const load = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/lazy-runtime-packages.js", () => ({ loadYaml: load }));
import { splitFrontmatter } from "../../src/plugins/registration/common.js";

beforeEach(() => { load.mockReset(); });

it("leaves the YAML parser unloaded for documents without complete frontmatter", () => {
  expect(load).not.toHaveBeenCalled();
  for (const raw of ["plain markdown", "---\nnot closed"]) {
    expect(splitFrontmatter(raw)).toEqual({ frontmatter: {}, markdown: raw });
  }
  expect(load).not.toHaveBeenCalled();
});

it("propagates a package-load failure instead of treating it as malformed YAML", () => {
  const failure = new Error("YAML package unavailable");
  load.mockImplementation(() => { throw failure; });
  expect(() => splitFrontmatter("---\nname: example\n---\nbody")).toThrow(failure);
  expect(load).toHaveBeenCalledOnce();
});

it("preserves malformed-frontmatter recovery after the parser loads", () => {
  const parse = vi.fn(() => { throw new Error("invalid YAML"); });
  load.mockReturnValue({ load: parse });
  expect(splitFrontmatter("---\nname: [broken\n---\nbody"))
    .toEqual({ frontmatter: {}, markdown: "body" });
  expect(parse).toHaveBeenCalledWith("name: [broken");
  expect(load).toHaveBeenCalledOnce();
});
