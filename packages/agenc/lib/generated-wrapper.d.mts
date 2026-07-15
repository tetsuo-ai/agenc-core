export type WrapperKind = "posix" | "cmd";

export interface GeneratedWrapper {
  readonly kind: WrapperKind;
  readonly path: string;
  readonly nodeBin: string;
  readonly runtimeBin: string;
  readonly agencHome: string;
}

export const GENERATED_WRAPPER_MAX_BYTES: number;

export function renderGeneratedWrapperContent(wrapper: {
  readonly kind: WrapperKind;
  readonly nodeBin: string;
  readonly runtimeBin: string;
  readonly agencHome: string;
}): string;

export function parseGeneratedWrapperContent(
  path: string,
  content: string,
): GeneratedWrapper | null;
