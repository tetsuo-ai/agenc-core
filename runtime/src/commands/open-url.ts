import { openLocalBrowser } from "../utils/browser.js";

/** Open a sign-in link in the local browser. */
export async function openUrlInBrowser(url: string): Promise<void> {
  await openLocalBrowser(url);
}
