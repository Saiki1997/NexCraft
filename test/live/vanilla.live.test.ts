/**
 * Live end-to-end check against the real services: Mojang's version list, the
 * official server JAR, a real Java runtime, and a real Minecraft server that is
 * started and then stopped gracefully. Needs internet, so it only runs when
 * NEXCRAFT_LIVE=1 (in CI's live job).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DownloadQueue } from "../../src/main/core/download-queue";
import { ProcessHost } from "../../src/main/core/process-host";
import { JavaService } from "../../src/main/java/java-service";
import { MojangClient } from "../../src/main/minecraft/mojang";
import { ServerService } from "../../src/main/servers/server-service";
import { StateService } from "../../src/main/services/state-service";
import type { ConsoleLine } from "../../src/shared/servers";
import { tmpDir } from "../helpers/tmp";

const USER_AGENT = "Saiki1997/NexCraft/ci (github.com/Saiki1997/NexCraft)";
const log = {
  debug() {},
  info: (m: string) => console.log(`[info] ${m}`),
  warn: (m: string) => console.log(`[warn] ${m}`),
  error: (m: string, e?: unknown) => console.log(`[error] ${m}`, e ?? ""),
};

function until(check: () => boolean, ms: number, what: string) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error(`Timed out waiting for ${what}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

describe.skipIf(!process.env.NEXCRAFT_LIVE)("live Vanilla server", () => {
  it("creates, starts and gracefully stops a real server", { timeout: 15 * 60_000 }, async () => {
    const root = tmpDir("nexcraft-live-");
    const state = new StateService(root, { available: () => false, seal: (s) => s, unseal: (s) => s }, log, 0);
    const downloads = new DownloadQueue({ userAgent: USER_AGENT, log });
    const processes = new ProcessHost();
    const java = new JavaService({ state, downloads, log, javaDir: () => path.join(root, "java"), userAgent: USER_AGENT });
    const mojang = new MojangClient(path.join(root, "cache"), USER_AGENT);
    const consoleLines: ConsoleLine[] = [];
    const servers = new ServerService({
      state,
      processes,
      downloads,
      java,
      mojang,
      log,
      serversDir: () => path.join(root, "servers"),
      emitStatus: (s) => console.log(`[status] ${s.state}`),
      emitConsole: (_id, lines) => {
        consoleLines.push(...lines);
        for (const l of lines) console.log(`[console] ${l.text}`);
      },
      emitInstall: (p) => console.log(`[install] ${p.step}: ${p.message}`),
    });

    const found = await java.detect();
    console.log(`Java found: ${found.map((r) => `${r.major} ${r.executable}`).join(", ") || "none"}`);

    const { latest, versions } = await mojang.versions();
    expect(versions.length).toBeGreaterThan(50);
    const version = process.env.NEXCRAFT_LIVE_VERSION || latest;

    const server = await servers.create({ name: "Live test", minecraftVersion: version, type: "vanilla", port: 25611, memoryMb: 2048 }, "live");
    expect(fs.statSync(path.join(server.directory, "server.jar")).size).toBeGreaterThan(1_000_000);
    await expect(servers.start(server.id)).rejects.toMatchObject({ code: "eula-required" });

    servers.acceptEula(server.id);
    await servers.start(server.id);
    await until(() => servers.status(server.id).state === "running" || servers.status(server.id).state === "crashed", 10 * 60_000, "the server to finish starting");
    expect(servers.status(server.id).state).toBe("running");
    console.log(`Started in ${servers.status(server.id).startupSeconds}s`);

    servers.sendCommand(server.id, "list");
    await until(() => consoleLines.some((l) => /There are 0 of a max of \d+ players online/.test(l.text)), 30_000, "the list command's reply");

    const result = await servers.stop(server.id, 120_000);
    expect(result).toBe("stopped");
    expect(servers.status(server.id).lastExit).toMatchObject({ code: 0, requested: true });
    expect(fs.existsSync(path.join(server.directory, "world", "level.dat"))).toBe(true);
    expect(servers.readProperties(server.id)["server-port"]).toBe("25611");
    servers.dispose();
  });

  it.skipIf(process.platform !== "win32")("installs a Temurin JRE from Adoptium and runs it", { timeout: 10 * 60_000 }, async () => {
    const root = tmpDir("nexcraft-live-java-");
    const state = new StateService(root, { available: () => false, seal: (s) => s, unseal: (s) => s }, log, 0);
    const downloads = new DownloadQueue({ userAgent: USER_AGENT, log });
    const java = new JavaService({ state, downloads, log, javaDir: () => path.join(root, "java"), userAgent: USER_AGENT });
    const runtime = await java.install(17);
    expect(runtime).toMatchObject({ major: 17, source: "managed" });
    expect(runtime.executable.startsWith(path.join(root, "java"))).toBe(true);
    expect((await java.verify(runtime.id)).major).toBe(17);
  });
});
