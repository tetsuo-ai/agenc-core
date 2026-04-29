export function normalizePickerProvider(provider: string | undefined): string {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return "xai";
  return normalized === "grok" ? "xai" : normalized;
}

export function formatPickerProviderLabel(provider: string): string {
  switch (provider) {
    case "xai":
      return "xAI";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    case "openrouter":
      return "OpenRouter";
    case "groq":
      return "Groq";
    case "deepseek":
      return "DeepSeek";
    case "ollama":
      return "Ollama";
    case "lmstudio":
      return "LM Studio";
    default:
      return provider;
  }
}
