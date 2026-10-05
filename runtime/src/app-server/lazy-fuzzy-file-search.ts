import type { AgenCFuzzyFileSearch } from "./fuzzy-file-search.js";

/** Keep the RPC registered without creating an index until a search arrives. */
export function createLazyFuzzyFileSearch(
  load: () => Promise<AgenCFuzzyFileSearch> = async () => {
    const { AgenCFuzzyFileSearchService } = await import("./fuzzy-file-search.js");
    return new AgenCFuzzyFileSearchService();
  },
): AgenCFuzzyFileSearch {
  let pending: Promise<AgenCFuzzyFileSearch> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    async search(params, options) {
      if (closed) throw new Error("fuzzy-file search service is closed");
      const service = await (pending ??= load());
      // Shutdown can begin while the module is loading. Do not start work
      // after the close fence; close() still disposes the loaded service.
      if (closed) throw new Error("fuzzy-file search service is closed");
      return service.search(params, options);
    },
    close() {
      closed = true;
      return closing ??= pending === undefined
        ? Promise.resolve()
        : pending.then(service => service.close?.()).then(() => undefined);
    },
  };
}
