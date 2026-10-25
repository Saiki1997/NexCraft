#!/usr/bin/env node
/** Development: Vite dev server for the UI, esbuild for main/preload, then Electron. */
import { spawn } from "node:child_process";
import { createServer } from "vite";

const server = await createServer({ configFile: "vite.config.ts" });
await server.listen();
const url = "http://127.0.0.1:5173/";

await new Promise((resolve, reject) => {
  const b = spawn(process.execPath, ["scripts/build-electron.mjs"], { stdio: "inherit" });
  b.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build-electron exited ${code}`))));
});

const electronPath = (await import("electron")).default;
const app = spawn(electronPath, ["."], { stdio: "inherit", env: { ...process.env, NEXCRAFT_DEV_URL: url } });
app.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
