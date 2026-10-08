/** Deliberately unsafe floor experiment. Never enable for production sessions. */
export function experimentMinimal(): boolean {
  return process.env.AGENC_EXPERIMENT_MINIMAL === "1";
}
