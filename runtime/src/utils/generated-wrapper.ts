// The launcher-side module is canonical because standalone installers must use
// this contract before the runtime exists. The runtime bundles the same parser
// and renderer to keep wrapper ownership byte-identical across every surface.

export {
  GENERATED_WRAPPER_MAX_BYTES,
  parseGeneratedWrapperContent,
  renderGeneratedWrapperContent,
  type GeneratedWrapper,
  type WrapperKind,
} from "../../../packages/agenc/lib/generated-wrapper.mjs";
