const guards = new WeakMap<object, { readonly check: (absolutePath: string) => boolean; readonly paths: Set<string> }>();

export function attachReadOnlyDelegationReadGuard(args: object, guard: (absolutePath: string) => boolean): void {
  guards.set(args, { check: guard, paths: new Set() });
}

export function readOnlyDelegationReadPathAllowed(args: object, absolutePath: string): boolean {
  const authority = guards.get(args);
  if (authority === undefined) return true;
  if (!authority.check(absolutePath)) return false;
  authority.paths.add(absolutePath);
  return true;
}

export function hasReadOnlyDelegationReadGuard(args: object): boolean {
  return guards.has(args);
}

export function readOnlyDelegationReadAuthorityCurrent(args: object): boolean {
  const authority = guards.get(args);
  return authority === undefined || [...authority.paths].every((path) => authority.check(path));
}
