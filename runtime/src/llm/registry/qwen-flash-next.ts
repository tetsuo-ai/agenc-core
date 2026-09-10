/** Official BF16 checkpoint identity; distinct from the QwenCloud Flash API. */
export const QWEN_FLASH_NEXT_MODEL = "Qwen/Qwen3.8-Flash-Next";

export function isQwenFlashNextModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === QWEN_FLASH_NEXT_MODEL.toLowerCase();
}
