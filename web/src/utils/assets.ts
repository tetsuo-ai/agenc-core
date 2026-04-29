function normalizeBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl || baseUrl.trim().length === 0) {
    return "/";
  }
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

export function assetUrl(relativePath: string): string {
  const baseUrl = normalizeBaseUrl(import.meta.env.BASE_URL);
  const normalizedPath = relativePath.replace(/^\/+/, "");
  return `${baseUrl}${normalizedPath}`;
}
