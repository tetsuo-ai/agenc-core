import { expect, test } from "vitest";

import {
  executeUserPromptSubmitHooks,
  type UserPromptSubmitHook,
} from "../../src/hooks/user-prompt-submit.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("preserves array-returning UserPromptSubmit hooks", async () => {
  const hooks: UserPromptSubmitHook[] = [
    () => [
      { additionalContexts: ["first"] },
      undefined,
      { additionalContexts: ["second"] },
    ],
  ];
  const results = await collect(
    executeUserPromptSubmitHooks("hello", "default", {
      cwd: "/workspace",
      userPromptSubmitHooks: hooks,
    }),
  );

  expect(results.map((result) => result.additionalContexts)).toEqual([
    ["first"],
    ["second"],
  ]);
});
