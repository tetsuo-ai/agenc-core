/**
 * The SDK workspace publishes generated declarations from dist/, which is not
 * present in a clean source checkout. The gateway validates the dynamically
 * imported module against its local SdkModule boundary, so typechecking only
 * needs the module's compile-time presence; the runtime build still builds and
 * bundles the real SDK workspace.
 */
declare module "@tetsuo-ai/agenc-sdk" {}
