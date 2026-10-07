import { vi } from "vitest";

export function hangingStreamAfterFirstChunk(options: {
  readonly settleOnAbort?: boolean;
  readonly settleOnReturn?: boolean;
} = {}): {
  readonly stream: AsyncIterable<unknown> & { abort: () => void };
  readonly abortSpy: ReturnType<typeof vi.fn>;
  readonly returnSpy: ReturnType<typeof vi.fn>;
  readonly settlePendingNext: () => void;
} {
  let settlePendingNext: (() => void) | undefined;
  const settle = (): void => settlePendingNext?.();
  const abortSpy = vi.fn(() => {
    if (options.settleOnAbort !== false) settle();
  });
  const returnSpy = vi.fn(async () => {
    if (options.settleOnReturn !== false) settle();
    return { done: true, value: undefined };
  });
  const stream: AsyncIterable<unknown> & { abort: () => void } = {
    abort: abortSpy,
    [Symbol.asyncIterator]() {
      let calls = 0;
      return {
        next: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              done: false,
              value: {
                model: "llama3.3",
                message: { role: "assistant", content: "hel" },
                prompt_eval_count: 5,
                eval_count: 1,
              },
            };
          }
          return await new Promise<IteratorResult<unknown>>((resolve) => {
            settlePendingNext = () =>
              resolve({ done: true, value: undefined });
          });
        },
        return: returnSpy,
      };
    },
  };
  return { stream, abortSpy, returnSpy, settlePendingNext: settle };
}
