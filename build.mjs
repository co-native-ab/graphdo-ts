import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.js",
  sourcemap: true,
  minify: false,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  // Bundle all dependencies; only keep Node.js built-ins external
  external: ["node:*"],
});
