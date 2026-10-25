import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLog, tmpDir } from "../../../test/helpers/tmp";
import type { JavaRuntime } from "../../shared/model";
import type { ConsoleLine, InstallProgress, ServerStatus } from "../../shared/servers";
import { DownloadQueue } from "../core/download-queue";
import { ProcessHost } from "../core/process-host";
import { StateService } from "../services/state-service";
import { buildJvmArgs, ServerService } from "./server-service";

const FAKE_MC = path.resolve(__dirname, "../../../test/helpers/fake-minecraft.cjs");
const JAR = Buffer.from("not really a jar, the fake server is a node script");
const JAR_SHA1 = createHash("sha1").update(JAR).digest("hex");

const java21: JavaRuntime = {
  id: "java-21",
  executable: process.execPath,
  major: 21,
  version: "21.0.5",
  vendor: "Test",
  arch: "x64",
  source: "detected",
  lastVerifiedAt: null,
};

const services: ServerService[] = [];
const hosts: ProcessHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) for (const id of h.runningIds()) await h.forceKill(id);
  for (const s of services.splice(0)) s.dispose();
});

function until(check: () => boolean, ms = 5000) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timed out waiting"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function setup(opts: { runtimes?: JavaRuntime[]; portFree?: boolean; versions?: Record<string, number> } = {}) {
  const root = tmpDir();
  const state = new StateService(root, { available: () => false, seal: (s) => s, unseal: (s) => s }, silentLog, 0);
  const processes = new ProcessHost();
  hosts.push(processes);
  const fetched: string[] = [];
  const downloads = new DownloadQueue({
    userAgent: "t",
    retryDelayMs: () => 1,
    fetch: (async (url: string) => {
      fetched.push(String(url));
      return new Response(JAR, { status: 200, headers: { "content-length": String(JAR.length) } });
    }) as unknown as typeof fetch,
  });
  const runtimes = opts.runtimes ?? [java21];
  const installs: number[] = [];
  const java = {
    list: () => runtimes,
    pickFor: (major: number) => runtimes.find((r) => r.major >= major) ?? null,
    detect: async () => runtimes,
    install: async (major: number) => {
      installs.push(major);
      const rt = { ...java21, id: `managed-${major}`, major, source: "managed" as const };
      runtimes.push(rt);
      return rt;
    },
  };
  const versions = opts.versions ?? { "1.21.4": 21 };
  const mojang = {
    serverDownload: async (v: string) => {
      if (!(v in versions)) throw new Error(`${v} is not in Mojang's version list`);
      return { versionId: v, url: `https://piston-data.mojang.com/v1/objects/${JAR_SHA1}/server.jar`, sha1: JAR_SHA1, size: JAR.length, javaMajor: versions[v], javaFromManifest: true };
    },
  };
  const statuses: ServerStatus[] = [];
  const consoleLines: ConsoleLine[] = [];
  const installSteps: InstallProgress[] = [];
  const svc = new ServerService({
    state,
    processes,
    downloads,
    java: java as never,
    mojang,
    log: silentLog,
    serversDir: () => path.join(root, "servers"),
    emitStatus: (s) => statuses.push(s),
    emitConsole: (_id, lines) => consoleLines.push(...lines),
    emitInstall: (p) => installSteps.push(p),
    portFree: async () => opts.portFree ?? true,
    metricsIntervalMs: 60_000,
    command: (_exe, args) => ({ executable: process.execPath, args: [FAKE_MC, ...args] }),
  });
  services.push(svc);
  return { root, svc, state, statuses, consoleLines, installSteps, fetched, installs, processes };
}

const baseInput = { name: "My Server", minecraftVersion: "1.21.4", type: "vanilla" as const };

describe("ServerService.create", () => {
  it("downloads the verified server JAR and writes settings, with the EULA not accepted", async () => {
    const { svc, installSteps, fetched } = setup();
    const server = await svc.create({ ...baseInput, port: 25570, maxPlayers: 5, motd: "Hi" }, "k1");
    expect(server).toMatchObject({ type: "vanilla", requiredJava: 21, javaRuntimeId: "java-21", eulaAccepted: false, port: 25570 });
    expect(fetched).toHaveLength(1);
    expect(fs.readFileSync(path.join(server.directory, "server.jar"))).toEqual(JAR);
    expect(fs.readFileSync(path.join(server.directory, "eula.txt"), "utf8")).toMatch(/^eula=false$/m);
    const props = svc.readProperties(server.id);
    expect(props).toMatchObject({ "server-port": "25570", "max-players": "5", motd: "Hi", "enable-rcon": "false" });
    expect(installSteps.map((s) => s.step)).toEqual(["version", "java", "download", "files", "done"]);
    expect(fs.readFileSync(path.join(server.directory, "start.bat"), "utf8")).toContain("-jar server.jar nogui");
  });

  it("installs Java when no suitable runtime is registered", async () => {
    const { svc, installs } = setup({ runtimes: [{ ...java21, id: "j8", major: 8 }], versions: { "1.21.4": 21 } });
    const server = await svc.create(baseInput, "k");
    expect(installs).toEqual([21]);
    expect(server.javaRuntimeId).toBe("managed-21");
  });

  it("refuses a chosen Java that is too old, and leaves no files behind on failure", async () => {
    const { svc, root, installSteps } = setup({ runtimes: [{ ...java21, id: "j17", major: 17 }] });
    await expect(svc.create({ ...baseInput, javaRuntimeId: "j17" }, "k")).rejects.toThrow(/too old/);
    await expect(svc.create({ ...baseInput, minecraftVersion: "9.9.9" }, "k")).rejects.toThrow(/not in Mojang/);
    expect(installSteps.at(-1)?.step).toBe("failed");
    expect(fs.existsSync(path.join(root, "servers", "My Server"))).toBe(false);
    expect(svc.list()).toEqual([]);
  });

  it("never reuses a non-empty folder", async () => {
    const { svc } = setup();
    const a = await svc.create(baseInput, "a");
    const b = await svc.create(baseInput, "b");
    expect(b.directory).not.toBe(a.directory);
    expect(path.basename(b.directory)).toBe("My Server (2)");
  });

  it("rejects input that is not a vanilla server or has a bad name", async () => {
    const { svc } = setup();
    await expect(svc.create({ ...baseInput, type: "forge" as never }, "k")).rejects.toThrow();
    await expect(svc.create({ ...baseInput, minecraftVersion: "1.21; rm -rf" }, "k")).rejects.toThrow();
  });
});

describe("ServerService lifecycle", () => {
  it("will not start until the EULA is accepted", async () => {
    const { svc } = setup();
    const server = await svc.create(baseInput, "k");
    await expect(svc.start(server.id)).rejects.toMatchObject({ code: "eula-required" });
    svc.acceptEula(server.id);
    expect(fs.readFileSync(path.join(server.directory, "eula.txt"), "utf8")).toMatch(/^eula=true$/m);
    // Accepted in NexCraft but reverted on disk by hand: still refused.
    fs.writeFileSync(path.join(server.directory, "eula.txt"), "eula=false\n");
    await expect(svc.start(server.id)).rejects.toMatchObject({ code: "eula-required" });
  });

  it("refuses to start when the port is taken", async () => {
    const { svc } = setup({ portFree: false });
    const server = await svc.create(baseInput, "k");
    svc.acceptEula(server.id);
    await expect(svc.start(server.id)).rejects.toMatchObject({ code: "port-in-use" });
  });

  it("starts, becomes ready, tracks players, and stops gracefully", async () => {
    const { svc, consoleLines } = setup();
    const server = await svc.create({ ...baseInput, memoryMb: 2048 }, "k");
    svc.acceptEula(server.id);
    await svc.start(server.id);
    await until(() => svc.status(server.id).state === "running");
    expect(svc.status(server.id).startupSeconds).toBeCloseTo(1.234);
    const startLine = svc.console(server.id).find((l) => l.text.includes("Starting minecraft server"));
    expect(startLine?.text).toContain("-Xms1024M -Xmx2048M -jar server.jar nogui");

    // A newline cannot smuggle in a second command: this arrives as one line, "join Alex stop".
    expect(svc.sendCommand(server.id, "/join Alex\nstop")).toBe(true);
    await until(() => svc.status(server.id).players.includes("Alex"));
    expect(svc.status(server.id).state).toBe("running");
    svc.sendCommand(server.id, "leave Alex");
    await until(() => svc.status(server.id).players.length === 0);

    await expect(svc.start(server.id)).rejects.toMatchObject({ code: "busy" });
    expect(await svc.stop(server.id, 5000)).toBe("stopped");
    const st = svc.status(server.id);
    expect(st.state).toBe("stopped");
    expect(st.lastExit).toMatchObject({ code: 0, requested: true });
    await until(() => consoleLines.some((l) => l.stream === "input" && l.text === "> stop"));
    expect(svc.list()[0].lastStartedAt).not.toBeNull();
  });

  it("reports a crash and records diagnostics", async () => {
    const { svc } = setup();
    const server = await svc.create(baseInput, "k");
    svc.acceptEula(server.id);
    await svc.start(server.id);
    await until(() => svc.status(server.id).state === "running");
    svc.sendCommand(server.id, "oom");
    await until(() => svc.status(server.id).findings.some((f) => f.id === "out-of-memory"));
    svc.sendCommand(server.id, "crash");
    await until(() => svc.status(server.id).state === "crashed");
    expect(svc.status(server.id).lastExit).toMatchObject({ code: 1, requested: false });
  });

  it("restarts and stops everything on quit", async () => {
    const { svc, processes } = setup();
    const server = await svc.create(baseInput, "k");
    svc.acceptEula(server.id);
    await svc.start(server.id);
    await until(() => svc.status(server.id).state === "running");
    const firstPid = svc.status(server.id).pid;
    await svc.restart(server.id);
    await until(() => svc.status(server.id).state === "running");
    expect(svc.status(server.id).pid).not.toBe(firstPid);
    const results = await svc.stopAll(5000);
    expect(results).toEqual([{ id: server.id, result: "stopped" }]);
    expect(processes.runningIds()).toEqual([]);
  });
});

describe("ServerService settings", () => {
  it("validates properties before writing and keeps the port in sync", async () => {
    const { svc } = setup();
    const server = await svc.create(baseInput, "k");
    expect(() => svc.updateProperties(server.id, { "server-port": "abc", motd: "x" })).toThrow(/server-port/);
    expect(svc.readProperties(server.id).motd).toBe("My Server");
    const res = svc.updateProperties(server.id, { "server-port": "25599", "view-distance": "8" });
    expect(res).toMatchObject({ restartRequired: false, values: { "server-port": "25599", "view-distance": "8" } });
    expect(svc.list()[0].port).toBe(25599);
  });

  it("only allows safe extra JVM options", async () => {
    const { svc } = setup();
    const server = await svc.create(baseInput, "k");
    expect(svc.updateResources(server.id, { extraJvmArgs: ["-XX:+UseG1GC", "-Dfile.encoding=UTF-8"] }).server.extraJvmArgs).toHaveLength(2);
    for (const bad of ["-jar", "-Xmx99G", "& calc.exe", "-cp", "notanoption"]) {
      expect(() => svc.updateResources(server.id, { extraJvmArgs: [bad] })).toThrow(/not allowed/);
    }
    expect(() => svc.updateResources(server.id, { javaRuntimeId: "nope" })).toThrow(/not registered/);
  });

  it("removes a server from the list but keeps its files", async () => {
    const { svc } = setup();
    const server = await svc.create(baseInput, "k");
    svc.remove(server.id);
    expect(svc.list()).toEqual([]);
    expect(fs.existsSync(path.join(server.directory, "server.jar"))).toBe(true);
  });
});

describe("buildJvmArgs", () => {
  it("puts extra options before -jar", () => {
    expect(buildJvmArgs({ memoryMb: 4096, extraJvmArgs: ["-XX:+UseG1GC"], serverJar: "server.jar" })).toEqual([
      "-Xms1024M",
      "-Xmx4096M",
      "-XX:+UseG1GC",
      "-jar",
      "server.jar",
      "nogui",
    ]);
  });
});
