import * as esbuild from "esbuild";
import path from "node:path";
const fake = path.resolve("test/ui/common-fake.js");
await esbuild.build({
  entryPoints: ["src/installer.js"], bundle: true, format: "esm", outfile: "../public/installer.js",
  plugins: [{ name: "fake", setup(b) { b.onResolve({ filter: /\.\/common\.js$/ }, (a) => a.importer.endsWith("common-fake.js") ? undefined : { path: fake }); } }],
});
