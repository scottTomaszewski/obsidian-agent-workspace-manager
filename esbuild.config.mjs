import esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv.includes("production");
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@homebridge/node-pty-prebuilt-multiarch", ...builtins],
  format: "cjs",
  target: "es2018",
  platform: "node",
  sourcemap: prod ? false : "inline",
  outfile: "main.js",
  logLevel: "info",
});
if (prod) { await ctx.rebuild(); process.exit(0); }
else { await ctx.watch(); }
