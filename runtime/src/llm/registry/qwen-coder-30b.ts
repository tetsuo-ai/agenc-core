/** Official nonthinking BF16 checkpoint used by the private AgenC pilot. */
export const QWEN_CODER_30B_MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct";

export function isQwenCoder30BModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === QWEN_CODER_30B_MODEL.toLowerCase();
}
