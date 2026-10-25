/**
 * Server lifecycle: create a Vanilla server, accept the EULA on the user's
 * explicit request, start, stop gracefully, restart, send console commands, and
 * track status, players, CPU and memory. Server files are only written inside
 * the server's own folder.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ServerInstance } from "../../shared/model";
import {
  CreateServerInputSchema,
  type ConsoleLine,
  type CreateServerInput,
  type InstallProgress,
  type ServerFinding,
  type ServerStatus,
} from "../../shared/servers";
import type { DownloadQueue } from "../core/download-queue";
import type { ScopedLogger } from "../core/logger";
import { CpuMeter, sampleProcess } from "../core/process-metrics";
import type { ProcessHost } from "../core/process-host";
import { isInside, toSafeName } from "../core/safe-path";
import type { JavaService } from "../java/java-service";
import { javaFit } from "../minecraft/java-requirement";
import type { MojangClient } from "../minecraft/mojang";
import type { StateService } from "../services/state-service";
import { JOIN_LINE, LEAVE_LINE, matchLine, READY_LINE, STOPPING_LINE } from "./log-rules";
import { ServerProperties, validateProperties } from "./server-properties";

const CONSOLE_LIMIT = 5000;
const EULA_URL = "https://aka.ms/MinecraftEULA";

export class ServerError extends Error {
  constructor(
    message: string,
    readonly code: "eula-required" | "java-missing" | "port-in-use" | "not-found" | "busy" | "invalid" | "files-missing",
  ) {
    super(message);
    this.name = "ServerError";
  }
}

export interface ServerServiceDeps {
  state: Pick<StateService, "servers" | "server" | "upsertServer" | "removeServer" | "snapshot">;
  processes: ProcessHost;
  downloads: DownloadQueue;
  java: Pick<JavaService, "pickFor" | "install" | "list" | "detect">;
  mojang: Pick<MojangClient, "serverDownload">;
  log: ScopedLogger;
  serversDir: () => string;
  emitStatus: (status: ServerStatus) => void;
  emitConsole: (id: string, lines: ConsoleLine[]) => void;
  emitInstall: (progress: InstallProgress) => void;
  /** Checks whether a TCP port can be bound. Injected for tests. */
  portFree?: (port: number) => Promise<boolean>;
  metricsIntervalMs?: number;
  platform?: NodeJS.Platform;
  /** Turns a Java executable and JVM arguments into the command to run. Tests swap in a fake server. */
  command?: (javaExe: string, args: string[]) => { executable: string; args: string[] };
}

interface Runtime {
  status: ServerStatus;
  console: ConsoleLine[];
  seq: number;
  pending: ConsoleLine[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  crashTimes: number[];
}

export class ServerService {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly cpu = new CpuMeter();
  private metricsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ServerServiceDeps) {
    deps.processes.on("output", (line) => this.onOutput(line.id, line.stream, line.text));
    deps.processes.on("exit", (info) => this.onExit(info.id, info.code, info.requested, info.at));
  }

  // ---- queries -------------------------------------------------------------

  list(): ServerInstance[] {
    return this.deps.state.servers();
  }

  status(id: string): ServerStatus {
    return structuredClone(this.runtime(id).status);
  }

  statuses(): ServerStatus[] {
    return this.list().map((s) => this.status(s.id));
  }

  console(id: string): ConsoleLine[] {
    return [...this.runtime(id).console];
  }

  isAnyRunning() {
    return this.deps.processes.runningIds().length > 0;
  }

  // ---- creation ------------------------------------------------------------

  async create(raw: CreateServerInput, progressKey: string): Promise<ServerInstance> {
    const input = CreateServerInputSchema.parse(raw);
    const report = (step: InstallProgress["step"], message: string) => this.deps.emitInstall({ key: progressKey, step, message });
    const parent = input.parentDir || this.deps.serversDir();
    if (!path.isAbsolute(parent)) throw new ServerError("The servers folder must be an absolute path", "invalid");
    const dir = uniqueDir(parent, toSafeName(input.name, "server"));
    let createdDir = false;
    try {
      report("version", `Looking up Minecraft ${input.minecraftVersion}`);
      const download = await this.deps.mojang.serverDownload(input.minecraftVersion);

      report("java", `Minecraft ${input.minecraftVersion} needs Java ${download.javaMajor}`);
      let runtime = input.javaRuntimeId ? this.deps.java.list().find((r) => r.id === input.javaRuntimeId) ?? null : null;
      if (runtime && javaFit(runtime.major, download.javaMajor) === "too-old") {
        throw new ServerError(`The chosen Java ${runtime.major} is too old; this version needs Java ${download.javaMajor}`, "java-missing");
      }
      if (!runtime) runtime = this.deps.java.pickFor(download.javaMajor);
      if (!runtime) {
        await this.deps.java.detect();
        runtime = this.deps.java.pickFor(download.javaMajor);
      }
      if (!runtime) {
        report("java", `Installing Java ${download.javaMajor}`);
        runtime = await this.deps.java.install(download.javaMajor);
      }

      fs.mkdirSync(dir, { recursive: true });
      createdDir = true;
      report("download", `Downloading the official server for ${input.minecraftVersion}`);
      const jar = path.join(dir, "server.jar");
      const { done } = this.deps.downloads.enqueue({
        url: download.url,
        dest: jar,
        title: `Minecraft ${input.minecraftVersion} server`,
        hash: { algo: "sha1", value: download.sha1 },
        size: download.size,
      });
      const result = await done;
      if (!result.ok) throw new Error(result.cancelled ? "Download cancelled" : `Server download failed: ${result.error}`);

      report("files", "Writing server settings");
      const props = ServerProperties.fresh({
        motd: input.motd || input.name,
        "server-port": String(input.port),
        "max-players": String(input.maxPlayers),
        "online-mode": String(input.onlineMode),
        difficulty: input.difficulty,
        gamemode: input.gamemode,
        "view-distance": String(input.viewDistance),
        "simulation-distance": String(input.simulationDistance),
        "level-name": input.worldName,
        "level-seed": input.seed,
        "enable-rcon": "false",
      });
      writeAtomic(path.join(dir, "server.properties"), props.toString());
      writeAtomic(path.join(dir, "eula.txt"), eulaText(false));

      const server: ServerInstance = {
        id: randomUUID(),
        name: input.name,
        directory: dir,
        minecraftVersion: input.minecraftVersion,
        type: "vanilla",
        loaderVersion: null,
        javaRuntimeId: runtime.id,
        requiredJava: download.javaMajor,
        serverJar: "server.jar",
        memoryMb: input.memoryMb,
        extraJvmArgs: [],
        port: input.port,
        eulaAccepted: false,
        eulaAcceptedAt: null,
        autoRestart: input.autoRestart,
        createdAt: new Date().toISOString(),
        lastStartedAt: null,
        lastBackupAt: null,
        modpack: null,
      };
      writeAtomic(path.join(dir, "start.bat"), startScript(server, runtime.executable));
      this.deps.state.upsertServer(server);
      report("done", `${input.name} is ready`);
      this.deps.log.info(`Created Vanilla ${input.minecraftVersion} server "${input.name}" at ${dir}`);
      return server;
    } catch (err) {
      report("failed", (err as Error).message);
      if (createdDir) removeOwnFiles(dir);
      throw err;
    }
  }

  /** Forget a server. Its files stay on disk; deleting them is a separate, confirmed action. */
  remove(id: string) {
    if (this.deps.processes.isRunning(id)) throw new ServerError("Stop the server before removing it", "busy");
    this.need(id);
    this.deps.state.removeServer(id);
    this.runtimes.delete(id);
  }

  // ---- EULA ----------------------------------------------------------------

  /** Called only after the user ticked "I accept" in the UI. */
  acceptEula(id: string): ServerInstance {
    const server = this.need(id);
    writeAtomic(path.join(server.directory, "eula.txt"), eulaText(true));
    const updated = { ...server, eulaAccepted: true, eulaAcceptedAt: new Date().toISOString() };
    this.deps.state.upsertServer(updated);
    this.deps.log.info(`EULA accepted by the user for "${server.name}"`);
    return updated;
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(id: string): Promise<ServerStatus> {
    const server = this.need(id);
    const rt = this.runtime(id);
    if (this.deps.processes.isRunning(id)) throw new ServerError("The server is already running", "busy");
    if (!server.eulaAccepted || !eulaAcceptedOnDisk(server.directory)) {
      throw new ServerError("Accept the Minecraft EULA before starting this server", "eula-required");
    }
    const jar = path.join(server.directory, server.serverJar);
    if (!isInside(server.directory, jar) || !fs.existsSync(jar)) throw new ServerError("The server JAR is missing. Repair the server first.", "files-missing");

    const runtime = this.deps.java.list().find((r) => r.id === server.javaRuntimeId) ?? this.deps.java.pickFor(server.requiredJava);
    if (!runtime || !fs.existsSync(runtime.executable)) {
      throw new ServerError(`Java ${server.requiredJava} is not available. Install it from the server's settings.`, "java-missing");
    }
    if (javaFit(runtime.major, server.requiredJava) === "too-old") {
      throw new ServerError(`Java ${runtime.major} is too old for Minecraft ${server.minecraftVersion}; it needs Java ${server.requiredJava}`, "java-missing");
    }
    const port = this.currentPort(server);
    if (!(await (this.deps.portFree ?? isPortFree)(port))) {
      throw new ServerError(`Port ${port} is already in use by another program or server`, "port-in-use");
    }

    const args = buildJvmArgs(server);
    rt.status = { ...emptyStatus(id), state: "starting", startedAt: new Date().toISOString() };
    this.system(id, `Starting with Java ${runtime.version} (${runtime.executable}), ${server.memoryMb} MB memory`);
    this.emit(id);
    try {
      const cmd = this.deps.command?.(runtime.executable, args) ?? { executable: runtime.executable, args };
      const { pid } = await this.deps.processes.start(id, { ...cmd, cwd: server.directory });
      rt.status.pid = pid;
      this.deps.state.upsertServer({ ...server, lastStartedAt: rt.status.startedAt, javaRuntimeId: runtime.id });
      this.ensureMetrics();
      this.emit(id);
      return this.status(id);
    } catch (err) {
      rt.status = { ...emptyStatus(id), state: "crashed", lastExit: { code: null, at: new Date().toISOString(), requested: false } };
      this.system(id, `Could not start Java: ${(err as Error).message}`);
      this.emit(id);
      throw err;
    }
  }

  /** Graceful stop: `stop` on the console, then wait. Never force-kills by itself. */
  async stop(id: string, timeoutMs = 90_000): Promise<"stopped" | "timeout" | "not-running"> {
    this.need(id);
    const rt = this.runtime(id);
    if (!this.deps.processes.isRunning(id)) return "not-running";
    rt.status.state = "stopping";
    this.emit(id);
    this.input(id, "stop");
    const result = await this.deps.processes.stop(id, { stopCommand: "stop", timeoutMs });
    if (result === "timeout") {
      this.system(id, `The server did not stop within ${Math.round(timeoutMs / 1000)} seconds. You can wait longer or force stop it.`);
      rt.status.state = "running";
      this.emit(id);
    }
    return result;
  }

  /** Only after the user confirmed: ends the server's process tree without saving. */
  async forceStop(id: string): Promise<boolean> {
    this.need(id);
    return this.deps.processes.forceKill(id);
  }

  async restart(id: string): Promise<ServerStatus> {
    const result = await this.stop(id);
    if (result === "timeout") throw new ServerError("The server did not stop in time, so it was not restarted", "busy");
    return this.start(id);
  }

  sendCommand(id: string, command: string): boolean {
    this.need(id);
    const clean = command.replace(/[\r\n]+/g, " ").trim().replace(/^\//, "");
    if (!clean) return false;
    if (!this.deps.processes.isRunning(id)) throw new ServerError("The server is not running", "busy");
    this.input(id, clean);
    if (clean === "stop") this.runtime(id).status.state = "stopping";
    return this.deps.processes.send(id, clean);
  }

  // ---- settings ------------------------------------------------------------

  readProperties(id: string): Record<string, string> {
    const server = this.need(id);
    const file = path.join(server.directory, "server.properties");
    if (!fs.existsSync(file)) return {};
    return ServerProperties.parse(fs.readFileSync(file, "utf8")).entries();
  }

  /** Validates every value first; nothing is written if any value is invalid. */
  updateProperties(id: string, values: Record<string, string>): { values: Record<string, string>; restartRequired: boolean } {
    const server = this.need(id);
    const errors = validateProperties(values);
    if (errors.length) throw new ServerError(errors.map((e) => `${e.key}: ${e.message}`).join("; "), "invalid");
    const file = path.join(server.directory, "server.properties");
    const props = fs.existsSync(file) ? ServerProperties.parse(fs.readFileSync(file, "utf8")) : ServerProperties.fresh({});
    props.setMany(values);
    writeAtomic(file, props.toString());
    if (values["server-port"]) this.deps.state.upsertServer({ ...server, port: Number(values["server-port"]) });
    return { values: props.entries(), restartRequired: this.deps.processes.isRunning(id) };
  }

  updateResources(id: string, patch: { memoryMb?: number; extraJvmArgs?: string[]; javaRuntimeId?: string | null; autoRestart?: boolean; name?: string }) {
    const server = this.need(id);
    if (patch.extraJvmArgs) {
      for (const arg of patch.extraJvmArgs) {
        if (!/^-[\w:.+=\-,/%]+$/.test(arg) || /^-(jar|cp|classpath)$/i.test(arg) || /^-Xm[sx]/i.test(arg)) {
          throw new ServerError(`"${arg}" is not allowed as an extra JVM option`, "invalid");
        }
      }
    }
    if (patch.javaRuntimeId) {
      const rt = this.deps.java.list().find((r) => r.id === patch.javaRuntimeId);
      if (!rt) throw new ServerError("That Java runtime is not registered", "invalid");
      if (javaFit(rt.major, server.requiredJava) === "too-old") throw new ServerError(`Java ${rt.major} is too old for this server`, "invalid");
    }
    const updated = { ...server, ...patch };
    this.deps.state.upsertServer(updated);
    return { server: updated, restartRequired: this.deps.processes.isRunning(id) };
  }

  /** Stop everything gracefully, e.g. on app quit. */
  async stopAll(timeoutMs = 90_000) {
    const ids = this.deps.processes.runningIds();
    return Promise.all(ids.map(async (id) => ({ id, result: await this.stop(id, timeoutMs) })));
  }

  dispose() {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.metricsTimer = null;
  }

  // ---- internals -----------------------------------------------------------

  private need(id: string): ServerInstance {
    const server = this.deps.state.server(id);
    if (!server) throw new ServerError("That server no longer exists", "not-found");
    return server;
  }

  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = { status: emptyStatus(id), console: [], seq: 0, pending: [], flushTimer: null, crashTimes: [] };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  private currentPort(server: ServerInstance): number {
    const props = this.readProperties(server.id);
    const port = Number(props["server-port"] ?? server.port);
    return Number.isInteger(port) && port > 0 ? port : 25565;
  }

  private onOutput(id: string, stream: "stdout" | "stderr" | "system", text: string) {
    const rt = this.runtime(id);
    this.push(id, stream, text);
    let changed = false;
    const ready = READY_LINE.exec(text);
    if (ready && rt.status.state === "starting") {
      rt.status.state = "running";
      rt.status.readyAt = new Date().toISOString();
      rt.status.startupSeconds = Number(ready[1].replace(",", "."));
      changed = true;
    }
    if (STOPPING_LINE.test(text) && rt.status.state !== "stopped") {
      rt.status.state = "stopping";
      changed = true;
    }
    const join = JOIN_LINE.exec(text);
    if (join && !rt.status.players.includes(join[1])) {
      rt.status.players = [...rt.status.players, join[1]];
      changed = true;
    }
    const leave = LEAVE_LINE.exec(text);
    if (leave) {
      rt.status.players = rt.status.players.filter((p) => p !== leave[1]);
      changed = true;
    }
    const finding = matchLine(text);
    if (finding && !rt.status.findings.some((f) => f.id === finding.id)) {
      rt.status.findings = [...rt.status.findings, { ...finding, at: new Date().toISOString() } as ServerFinding];
      changed = true;
    }
    if (changed) this.emit(id);
  }

  private onExit(id: string, code: number | null, requested: boolean, at: string) {
    const rt = this.runtime(id);
    const crashed = !requested && code !== 0;
    rt.status = {
      ...rt.status,
      state: crashed ? "crashed" : "stopped",
      pid: null,
      players: [],
      cpuPercent: null,
      memoryMb: null,
      lastExit: { code, at, requested },
    };
    this.cpu.forget(id);
    this.system(id, crashed ? `The server stopped unexpectedly (exit code ${code ?? "unknown"})` : "The server has stopped");
    this.emit(id);
    if (!this.deps.processes.runningIds().length) this.dispose();

    const server = this.deps.state.server(id);
    if (crashed && server?.autoRestart) {
      const now = Date.now();
      rt.crashTimes = [...rt.crashTimes.filter((t) => now - t < 10 * 60_000), now];
      if (rt.crashTimes.length > 3) {
        this.system(id, "Automatic restart is paused: the server crashed more than 3 times in 10 minutes");
        return;
      }
      this.system(id, "Restarting automatically in 10 seconds");
      setTimeout(() => {
        if (!this.deps.processes.isRunning(id)) this.start(id).catch((err) => this.system(id, `Automatic restart failed: ${(err as Error).message}`));
      }, 10_000);
    }
  }

  private ensureMetrics() {
    if (this.metricsTimer) return;
    this.metricsTimer = setInterval(() => void this.sampleAll(), this.deps.metricsIntervalMs ?? 3000);
  }

  private async sampleAll() {
    for (const id of this.deps.processes.runningIds()) {
      const pid = this.deps.processes.pid(id);
      if (!pid) continue;
      const sample = await sampleProcess(pid, this.deps.platform);
      const rt = this.runtimes.get(id);
      if (!sample || !rt) continue;
      rt.status.cpuPercent = this.cpu.percent(id, sample);
      rt.status.memoryMb = Math.round(sample.rssBytes / 1024 / 1024);
      this.emit(id);
    }
  }

  private input(id: string, command: string) {
    this.push(id, "input", `> ${command}`);
  }

  private system(id: string, text: string) {
    this.push(id, "system", text);
  }

  private push(id: string, stream: ConsoleLine["stream"], text: string) {
    const rt = this.runtime(id);
    const line: ConsoleLine = { seq: ++rt.seq, at: new Date().toISOString(), stream, text };
    rt.console.push(line);
    if (rt.console.length > CONSOLE_LIMIT) rt.console.splice(0, rt.console.length - CONSOLE_LIMIT);
    rt.pending.push(line);
    // Batch console events so a chatty server does not flood the UI.
    if (!rt.flushTimer) {
      rt.flushTimer = setTimeout(() => {
        rt.flushTimer = null;
        const batch = rt.pending.splice(0);
        if (batch.length) this.deps.emitConsole(id, batch);
      }, 100);
    }
  }

  private emit(id: string) {
    this.deps.emitStatus(this.status(id));
  }
}

export function buildJvmArgs(server: Pick<ServerInstance, "memoryMb" | "extraJvmArgs" | "serverJar">): string[] {
  const xms = Math.min(server.memoryMb, 1024);
  return [`-Xms${xms}M`, `-Xmx${server.memoryMb}M`, ...server.extraJvmArgs, "-jar", server.serverJar, "nogui"];
}

/** Warn when the requested heap leaves too little memory for Windows. */
export function memoryWarning(memoryMb: number, totalMb = os.totalmem() / 1024 / 1024): string | null {
  if (memoryMb > totalMb - 2048) return `This leaves less than 2 GB for Windows and other programs (this PC has ${Math.round(totalMb / 1024)} GB).`;
  if (memoryMb > totalMb * 0.75) return "This is more than three quarters of this PC's memory. Other programs may slow down.";
  return null;
}

function emptyStatus(id: string): ServerStatus {
  return {
    id,
    state: "stopped",
    pid: null,
    startedAt: null,
    readyAt: null,
    startupSeconds: null,
    players: [],
    cpuPercent: null,
    memoryMb: null,
    lastExit: null,
    findings: [],
  };
}

export function eulaText(accepted: boolean) {
  const stamp = new Date().toString();
  return [
    `#By changing the setting below to TRUE you are indicating your agreement to our EULA (${EULA_URL}).`,
    accepted ? `#Accepted by the server owner in NexCraft on ${stamp}` : "#NexCraft will only change this after you accept the EULA yourself.",
    `eula=${accepted ? "true" : "false"}`,
    "",
  ].join("\n");
}

function eulaAcceptedOnDisk(dir: string) {
  try {
    return /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(dir, "eula.txt"), "utf8"));
  } catch {
    return false;
  }
}

function startScript(server: ServerInstance, javaExe: string) {
  const args = buildJvmArgs(server).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  return [
    "@echo off",
    "rem Generated by NexCraft. Starting the server from NexCraft is recommended so it can stop it safely.",
    `cd /d "%~dp0"`,
    `"${javaExe}" ${args}`,
    "pause",
    "",
  ].join("\r\n");
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.nexcraft-tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function uniqueDir(parent: string, name: string): string {
  let candidate = path.join(parent, name);
  for (let i = 2; fs.existsSync(candidate) && fs.readdirSync(candidate).length > 0; i++) {
    candidate = path.join(parent, `${name} (${i})`);
  }
  return candidate;
}

/** Undo a failed create: remove only the files NexCraft writes during creation. */
function removeOwnFiles(dir: string) {
  for (const f of ["server.jar", "server.jar.part", "server.properties", "eula.txt", "start.bat"]) fs.rmSync(path.join(dir, f), { force: true });
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Leave it.
  }
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "0.0.0.0", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}
