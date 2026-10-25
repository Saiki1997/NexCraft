#!/usr/bin/env node
/**
 * Bundle the Electron main process and preload script with esbuild.
 * The CurseForge key is read from the CURSEFORGE_API_KEY environment variable
 * (a GitHub Actions secret in CI) and injected as a constant; it is never
 * written to the repository.
 */
import { build } from "esbuild";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const curseforgeKey = (process.env.CURSEFORGE_API_KEY || "").trim();
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: watch ? "inline" : false,
  external: ["electron"],
  logLevel: "info",
  define: {
    __NEXCRAFT_VERSION__: JSON.stringify(pkg.version),
    __NEXCRAFT_CURSEFORGE_KEY__: JSON.stringify(curseforgeKey),
  },
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/main/index.ts"], outfile: "out/main/index.cjs" }),
  build({ ...shared, entryPoints: ["src/preload/index.ts"], outfile: "out/preload/index.cjs" }),
]);
console.log(`Built main and preload for NexCraft ${pkg.version} (CurseForge key ${curseforgeKey ? "included" : "not set"})`);
