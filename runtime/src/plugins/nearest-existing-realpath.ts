import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Real path of `path`, or of its nearest existing ancestor plus the missing tail. */
export async function nearestExistingRealpath(path: string): Promise<string | undefined> {
  let cursor = resolve(path);
  const pending: string[] = [];
  for (;;) {
    try {
      await lstat(cursor);
      const real = await realpath(cursor);
      return pending.reduceRight((parent, name) => join(parent, name), real);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      pending.push(basename(cursor));
      cursor = parent;
    }
  }
}
