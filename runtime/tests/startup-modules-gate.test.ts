import { describe, expect, test } from "vitest";

import {
  FORBIDDEN_BEFORE_FIRST_REQUEST,
  findStartupOffenders,
  parseStartupTrace,
} from "../scripts/check-startup-modules/runner.mjs";

const NM = "file:///opt/agenc/node_modules";

describe("startup-modules gate", () => {
  test("parses the trace header and load lines", () => {
    const trace = parseStartupTrace(
      `# ["/opt/agenc/runtime/bin/agenc","daemon","start"]\n100 ${NM}/zod/index.js\n101 ${NM}/axios/index.js\n`,
    );
    expect(trace.argv).toBe('["/opt/agenc/runtime/bin/agenc","daemon","start"]');
    expect(trace.loads).toEqual([
      { time: 100, url: `${NM}/zod/index.js` },
      { time: 101, url: `${NM}/axios/index.js` },
    ]);
  });

  test("flags each listed package loaded before the first request, once per process", () => {
    const traces = [
      parseStartupTrace(
        `# ["daemon"]\n10 ${NM}/axios/lib/axios.js\n11 ${NM}/axios/lib/core.js\n12 ${NM}/lodash-es/lodash.js\n13 ${NM}/@modelcontextprotocol/sdk/client/index.js\n14 ${NM}/ajv/dist/ajv.js\n15 ${NM}/ajv-formats/dist/index.js\n`,
      ),
    ];
    const offenders = findStartupOffenders(traces, 1000);
    expect(offenders.map((o) => o.url)).toEqual([
      `${NM}/axios/lib/axios.js`,
      `${NM}/lodash-es/lodash.js`,
      `${NM}/@modelcontextprotocol/sdk/client/index.js`,
      `${NM}/ajv/dist/ajv.js`,
    ]);
    expect(offenders).toHaveLength(FORBIDDEN_BEFORE_FIRST_REQUEST.length);
  });

  test("allows single lodash functions and anything loaded after the first request", () => {
    const traces = [
      parseStartupTrace(`# ["cli"]\n10 ${NM}/lodash-es/memoize.js\n2000 ${NM}/axios/lib/axios.js\n`),
    ];
    expect(findStartupOffenders(traces, 1000)).toEqual([]);
  });
});
