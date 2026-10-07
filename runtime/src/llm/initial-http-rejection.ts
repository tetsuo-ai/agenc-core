import { AsyncLocalStorage } from "node:async_hooks";
import { markLLMInitialHttpRejection } from "./errors.js";

interface OpeningAttempt {
  responses: number;
  status?: number;
}
const openingAttempt = new AsyncLocalStorage<OpeningAttempt>();

/** Observe SDK fetch results before its parser or stream iterator can fail. */
export function observeInitialHttpResponse(response: Response): Response {
  const attempt = openingAttempt.getStore();
  if (attempt) {
    attempt.responses += 1;
    attempt.status = response.status;
  }
  return response;
}

/** Scoped per SDK opening call, including concurrent calls on one client. */
export async function withInitialHttpRejection<T>(
  provider: string,
  singleWireAttempt: boolean | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  const attempt: OpeningAttempt = { responses: 0 };
  return openingAttempt.run(attempt, async () => {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof Error && attempt.responses === 1) {
        markLLMInitialHttpRejection(error, provider, attempt.status, singleWireAttempt);
      }
      throw error;
    }
  });
}
