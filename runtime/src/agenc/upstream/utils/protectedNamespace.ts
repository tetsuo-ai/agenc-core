export function isProtectedNamespace(_ns: string): boolean { return false }
export function checkProtectedNamespace(): boolean { return isProtectedNamespace('') }
export const PROTECTED_NAMESPACES: string[] = []
