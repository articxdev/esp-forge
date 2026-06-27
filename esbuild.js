// @ts-check
const esbuild = require("esbuild");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: [
    "vscode",
    "serialport",
    "usb-detection",
    // Native modules that cannot be bundled
    "@serialport/bindings-cpp",
    "usb"
  ],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"'
  },
  logLevel: "info",
  plugins: [
    {
      name: "build-reporter",
      setup(build) {
        build.onStart(() => {
          console.log("[ESP Forge] Build started...");
        });
        build.onEnd((result) => {
          if (result.errors.length > 0) {
            console.error(`[ESP Forge] Build failed with ${result.errors.length} error(s)`);
          } else {
            console.log("[ESP Forge] Build complete.");
          }
        });
      }
    }
  ]
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("[ESP Forge] Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
