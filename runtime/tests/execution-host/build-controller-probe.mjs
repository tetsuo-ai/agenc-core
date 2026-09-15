import { build } from "esbuild";
import { createRequire } from "node:module";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import productionBuild from "../../build.config.ts";

if (process.argv.length !== 3) throw new Error("Expected an output path for the disposable controller probe");
const runtimeRoot = fileURLToPath(new URL("../../", import.meta.url));
const productionOptions = {};
productionBuild.esbuildOptions(productionOptions);
// Use the actual production feature definitions and text loaders. Keep installed
// dependencies bundled for the disposable host and leave only absent optional
// integrations external. Do not run the production asset plugin: it mutates dist.
const optionalExternals = productionBuild.external.filter((name) => {
  try { import.meta.resolve(name); return false; }
  catch (error) { if (["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes(error.code)) return true; throw error; }
});
const plugins = productionBuild.esbuildPlugins.filter((plugin) => plugin.name !== "agenc-runtime-assets").map((plugin) => {
  if (plugin.name !== "agenc-optional-external") return plugin;
  return { name: plugin.name, setup(build) {
    plugin.setup({ onResolve(filter, resolve) {
      build.onResolve(filter, async (args) => {
        if (args.pluginData?.probeInstalledDependency) return null;
        const result = resolve(args);
        if (result?.external && !args.path.startsWith(".")) {
          // Resolve using this import's actual conditions, including ESM-only
          // packages; require.resolve would misclassify those as unavailable.
          const installed = await build.resolve(args.path, { resolveDir: args.resolveDir, importer: args.importer,
            kind: args.kind, pluginData: { probeInstalledDependency: true } });
          if (installed.errors.length === 0) return installed;
        }
        return result;
      });
    } });
  } };
});
await build({ entryPoints: { [basename(process.argv[2], ".mjs")]: fileURLToPath(new URL("controller-probe.ts", import.meta.url)) },
  ...productionOptions,
  alias: { ...productionOptions.alias, "bun:bundle": join(runtimeRoot, "src/build/feature.ts") },
  plugins,
  external: optionalExternals,
  outdir: dirname(process.argv[2]), outExtension: { ".js": ".mjs" }, splitting: true,
  bundle: true, platform: "node", target: "node26", format: "esm",
  // Match Node's CommonJS interoperability for bundled runtime dependencies.
  banner: { js: 'import { createRequire as probeCreateRequire } from "node:module"; const require = probeCreateRequire(import.meta.url);' } });

// These parsers load installed dependencies using createRequire,
// which esbuild cannot discover from its static import graph. Stage the real
// locked package for the disposable controller, without rewriting production code.
for (const name of ["shell-quote", "js-yaml"]) {
  const dependencyRoot = join(dirname(process.argv[2]), "node_modules", name);
  await mkdir(dependencyRoot, { recursive: true });
  await build({ entryPoints: [createRequire(import.meta.url).resolve(name)],
    outfile: join(dependencyRoot, "index.cjs"), bundle: true, platform: "node", target: "node26", format: "cjs" });
  await writeFile(join(dependencyRoot, "package.json"), JSON.stringify({ name, main: "index.cjs" }));
}

// The classifier uses createRequire and its registered text loader, just as
// installed runtime entrypoints do. Copy the actual production assets into the
// disposable fixture; do not replace permission dependencies with test stubs.
await cp(join(runtimeRoot, "src/utils/permissions/yolo-classifier-prompts"),
  join(dirname(process.argv[2]), "yolo-classifier-prompts"), { recursive: true });
