export const checkProtectedNamespace = () => false
export function isProtectedNamespace(_ns: string): boolean { return checkProtectedNamespace() }
export const PROTECTED_NAMESPACES: string[] = []
