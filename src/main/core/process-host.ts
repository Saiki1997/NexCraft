/**
 * Owns every server process NexCraft starts. Processes are tracked by the
 * ChildProcess we spawned, so NexCraft never signals a PID it did not create.
 *
 * Stopping is graceful first: the stop command is written to the server's stdin
 * and we wait for a clean exit. Force-kill is a separate, explicit call.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";

export interface StartSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export type OutputStream = "stdout" | "stderr" | "system";

export interface OutputLine {
  id: string;
  stream: OutputStream;
  text: string;
  at: string;
}

export interface ExitInfo {
  id: string;
  code: number | null;
  signal: string | null;
  at: string;
  /** True when the exit followed a stop request from NexCraft. */
  requested: boolean;
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

interface Tracked {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  startedAt: string;
  stopRequested: boolean;
  exited: Promise<ExitInfo>;
  partial: Record<"stdout" | "stderr", string>;
}

export interface ProcessHostEvents {
  output: [OutputLine];
  exit: [ExitInfo];
}

export class ProcessHost extends EventEmitter<ProcessHostEvents> {
  private readonly procs = new Map<string, Tracked>();

  constructor(
    private readonly spawnFn: SpawnFn = spawn as unknown as SpawnFn,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly killTree: (pid: number) => void = defaultKillTree,
  ) {
    super();
  }

  isRunning(id: string) {
    return this.procs.has(id);
  }

  pid(id: string): number | null {
    return this.procs.get(id)?.pid ?? null;
  }

  runningIds() {
    return [...this.procs.keys()];
  }

  start(id: string, spec: StartSpec): Promise<{ pid: number }> {
    if (this.procs.has(id)) return Promise.reject(new Error("This server is already running"));
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(spec.executable, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          windowsHide: true,
          shell: false,
          detached: false,
        });
      } catch (err) {
        reject(err);
        return;
      }
      let settled = false;
      let exitResolve!: (info: ExitInfo) => void;
      const exited = new Promise<ExitInfo>((r) => (exitResolve = r));

      child.once("error", (err) => {
        if (!settled) {
          settled = true;
          this.procs.delete(id);
          reject(err);
        } else {
          this.line(id, "system", `Process error: ${err.message}`);
        }
      });
      child.once("spawn", () => {
        settled = true;
        const tracked: Tracked = {
          child,
          pid: child.pid!,
          startedAt: new Date().toISOString(),
          stopRequested: false,
          exited,
          partial: { stdout: "", stderr: "" },
        };
        this.procs.set(id, tracked);
        child.stdout.on("data", (buf: Buffer) => this.chunk(id, tracked, "stdout", buf));
        child.stderr.on("data", (buf: Buffer) => this.chunk(id, tracked, "stderr", buf));
        child.stdin.on("error", () => undefined);
        resolve({ pid: tracked.pid });
      });
      child.once("close", (code, signal) => {
        const tracked = this.procs.get(id);
        if (tracked) {
          for (const stream of ["stdout", "stderr"] as const) {
            if (tracked.partial[stream]) this.line(id, stream, tracked.partial[stream]);
          }
          this.procs.delete(id);
        }
        const info: ExitInfo = {
          id,
          code,
          signal: signal ?? null,
          at: new Date().toISOString(),
          requested: tracked?.stopRequested ?? false,
        };
        exitResolve(info);
        if (settled) this.emit("exit", info);
      });
    });
  }

  /** Write one command line to the server console. */
  send(id: string, command: string): boolean {
    const tracked = this.procs.get(id);
    if (!tracked || !tracked.child.stdin.writable) return false;
    const clean = command.replace(/[\r\n]+/g, " ").trim();
    if (!clean) return false;
    tracked.child.stdin.write(`${clean}\n`);
    return true;
  }

  /**
   * Ask the server to stop by sending `stopCommand` on stdin, then wait up to
   * `timeoutMs`. Resolves "stopped" on exit or "timeout" if it is still running;
   * it never force-kills on its own.
   */
  async stop(id: string, opts: { stopCommand?: string; timeoutMs?: number } = {}): Promise<"stopped" | "timeout" | "not-running"> {
    const tracked = this.procs.get(id);
    if (!tracked) return "not-running";
    tracked.stopRequested = true;
    this.line(id, "system", "Stop requested, waiting for the server to save and exit");
    this.send(id, opts.stopCommand ?? "stop");
    const timeoutMs = opts.timeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
    const result = await Promise.race([tracked.exited.then(() => "stopped" as const), timedOut]);
    clearTimeout(timer);
    return result;
  }

  /** Terminate the process tree we started. Only call after the user confirmed. */
  async forceKill(id: string, waitMs = 10_000): Promise<boolean> {
    const tracked = this.procs.get(id);
    if (!tracked) return false;
    tracked.stopRequested = true;
    this.line(id, "system", "Force stop: terminating the server process");
    if (this.platform === "win32") this.killTree(tracked.pid);
    else tracked.child.kill("SIGKILL");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([
      tracked.exited.then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), waitMs))),
    ]);
    clearTimeout(timer);
    return ok;
  }

  private chunk(id: string, tracked: Tracked, stream: "stdout" | "stderr", buf: Buffer) {
    const text = tracked.partial[stream] + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    tracked.partial[stream] = lines.pop() ?? "";
    // Guard against a runaway line with no newline.
    if (tracked.partial[stream].length > 64_000) {
      lines.push(tracked.partial[stream]);
      tracked.partial[stream] = "";
    }
    for (const line of lines) this.line(id, stream, line);
  }

  private line(id: string, stream: OutputStream, text: string) {
    this.emit("output", { id, stream, text, at: new Date().toISOString() });
  }
}

function defaultKillTree(pid: number) {
  // taskkill /T ends the tree rooted at the PID we spawned, not other Java processes.
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  killer.on("error", () => undefined);
}
