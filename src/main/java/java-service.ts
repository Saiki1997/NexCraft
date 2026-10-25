/**
 * Java runtime management: detect installed runtimes, add a custom one, install
 * Eclipse Temurin JREs side by side in NexCraft's Java folder, and choose a
 * runtime for a server. NexCraft never changes the system-wide Java.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JavaRuntime } from "../../shared/model";
import { extractZip, listZip } from "../core/archive";
import type { DownloadQueue } from "../core/download-queue";
import type { ScopedLogger } from "../core/logger";
import { toSafeName } from "../core/safe-path";
import { installableMajor, javaFit } from "../minecraft/java-requirement";
import type { StateService } from "../services/state-service";
import { latestJre } from "./adoptium";
import { candidateJavaPaths } from "./java-detect";
import { probeJava, type ExecFn, type JavaProbe } from "./java-probe";

export interface JavaServiceDeps {
  state: Pick<StateService, "javaRuntimes" | "setJavaRuntimes">;
  downloads: DownloadQueue;
  log: ScopedLogger;
  javaDir: () => string;
  userAgent: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exec?: ExecFn;
  fetch?: typeof fetch;
}

export class JavaService {
  private readonly platform: NodeJS.Platform;
  private installing = new Map<number, Promise<JavaRuntime>>();

  constructor(private readonly deps: JavaServiceDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  list(): JavaRuntime[] {
    return this.deps.state.javaRuntimes().sort((a, b) => b.major - a.major || a.executable.localeCompare(b.executable));
  }

  /** Scan standard locations and refresh the list. Custom and managed entries are kept. */
  async detect(): Promise<JavaRuntime[]> {
    const candidates = candidateJavaPaths({ platform: this.platform, env: this.deps.env ?? process.env, managedDir: this.deps.javaDir() });
    const managedRoot = path.resolve(this.deps.javaDir());
    const probes = await mapLimit(candidates, 4, async (exe) => {
      try {
        return await probeJava(exe, this.deps.exec);
      } catch (err) {
        this.deps.log.debug(`Skipping ${exe}: ${(err as Error).message}`);
        return null;
      }
    });
    const now = new Date().toISOString();
    const existing = this.deps.state.javaRuntimes();
    const keep = existing.filter((r) => r.source !== "detected" && fs.existsSync(r.executable));
    const known = new Set(keep.map((r) => key(r.executable)));
    const detected: JavaRuntime[] = [];
    for (const probe of probes) {
      if (!probe || known.has(key(probe.executable))) continue;
      known.add(key(probe.executable));
      const isManaged = path.resolve(probe.executable).startsWith(managedRoot + path.sep);
      const previous = existing.find((r) => key(r.executable) === key(probe.executable));
      detected.push(toRuntime(probe, isManaged ? "managed" : "detected", now, previous?.id));
    }
    const list = [...keep, ...detected];
    this.deps.state.setJavaRuntimes(list);
    this.deps.log.info(`Java scan found ${detected.length} runtime(s); ${list.length} known in total`);
    return this.list();
  }

  /** Register a runtime the user picked by hand, after checking it actually runs. */
  async addCustom(executable: string): Promise<JavaRuntime> {
    const p = this.platform === "win32" ? path.win32 : path.posix;
    const base = p.basename(executable).toLowerCase();
    const allowed = this.platform === "win32" ? ["java.exe", "javaw.exe"] : ["java"];
    if (!allowed.includes(base)) throw new Error(`Choose a Java executable (${allowed.join(" or ")}), not ${p.basename(executable)}`);
    const exe = base === "javaw.exe" ? p.join(p.dirname(executable), "java.exe") : executable;
    const probe = await probeJava(exe, this.deps.exec);
    const list = this.deps.state.javaRuntimes().filter((r) => key(r.executable) !== key(exe));
    const runtime = toRuntime(probe, "custom", new Date().toISOString());
    this.deps.state.setJavaRuntimes([...list, runtime]);
    this.deps.log.info(`Added custom Java ${probe.version} at ${exe}`);
    return runtime;
  }

  /** Re-run the executable to confirm it still works. */
  async verify(id: string): Promise<JavaRuntime> {
    const list = this.deps.state.javaRuntimes();
    const runtime = list.find((r) => r.id === id);
    if (!runtime) throw new Error("That Java runtime is no longer registered");
    const probe = await probeJava(runtime.executable, this.deps.exec);
    const updated = { ...toRuntime(probe, runtime.source, new Date().toISOString(), runtime.id) };
    this.deps.state.setJavaRuntimes(list.map((r) => (r.id === id ? updated : r)));
    return updated;
  }

  /** Best registered runtime for a required major version, or null. */
  pickFor(requiredMajor: number, preferredId?: string | null): JavaRuntime | null {
    const list = this.list().filter((r) => r.arch === "x64" || r.arch === "arm64" || r.arch === "unknown");
    if (preferredId) {
      const preferred = list.find((r) => r.id === preferredId);
      if (preferred && javaFit(preferred.major, requiredMajor) !== "too-old") return preferred;
    }
    const ok = list.filter((r) => javaFit(r.major, requiredMajor) === "ok");
    ok.sort((a, b) => {
      const exactA = a.major === requiredMajor ? 0 : 1;
      const exactB = b.major === requiredMajor ? 0 : 1;
      if (exactA !== exactB) return exactA - exactB;
      if (a.source === "managed" && b.source !== "managed") return -1;
      if (b.source === "managed" && a.source !== "managed") return 1;
      return a.major - b.major;
    });
    return ok[0] ?? null;
  }

  /**
   * Download and unpack a Temurin JRE for `requiredMajor` into NexCraft's Java
   * folder. Concurrent requests for the same version share one install.
   */
  install(requiredMajor: number, serverId: string | null = null): Promise<JavaRuntime> {
    const major = installableMajor(requiredMajor);
    const running = this.installing.get(major);
    if (running) return running;
    const task = this.doInstall(major, serverId).finally(() => this.installing.delete(major));
    this.installing.set(major, task);
    return task;
  }

  private async doInstall(major: number, serverId: string | null): Promise<JavaRuntime> {
    if (this.platform !== "win32") throw new Error("Automatic Java installation is available on Windows. Install Java yourself and run a scan.");
    const pkg = await latestJre(major, { userAgent: this.deps.userAgent, fetch: this.deps.fetch });
    const root = this.deps.javaDir();
    const folder = path.join(root, toSafeName(`temurin-${pkg.version}-jre`));
    const exe = path.join(folder, "bin", "java.exe");
    if (!fs.existsSync(exe)) {
      const archive = path.join(root, "_downloads", toSafeName(pkg.fileName));
      const { done } = this.deps.downloads.enqueue({
        url: pkg.url,
        dest: archive,
        title: `Java ${major} (Temurin ${pkg.version})`,
        hash: { algo: "sha256", value: pkg.sha256 },
        size: pkg.size,
        serverId,
      });
      const result = await done;
      if (!result.ok) throw new Error(result.cancelled ? "Java download was cancelled" : `Java download failed: ${result.error}`);

      const entries = await listZip(archive);
      const top = commonTopFolder(entries.map((e) => e.name));
      const staging = `${folder}.partial`;
      fs.rmSync(staging, { recursive: true, force: true });
      await extractZip(archive, staging, { stripPrefix: top ?? undefined });
      if (!fs.existsSync(path.join(staging, "bin", "java.exe"))) throw new Error("The downloaded Java package does not contain bin\\java.exe");
      fs.rmSync(folder, { recursive: true, force: true });
      fs.renameSync(staging, folder);
      fs.rmSync(archive, { force: true });
    }
    const probe = await probeJava(exe, this.deps.exec);
    if (probe.major !== major) throw new Error(`Installed Java reports version ${probe.version}, expected ${major}`);
    const list = this.deps.state.javaRuntimes().filter((r) => key(r.executable) !== key(exe));
    const runtime = toRuntime(probe, "managed", new Date().toISOString());
    this.deps.state.setJavaRuntimes([...list, runtime]);
    this.deps.log.info(`Installed Java ${probe.version} at ${folder}`);
    return runtime;
  }
}

function toRuntime(probe: JavaProbe, source: JavaRuntime["source"], now: string, id?: string): JavaRuntime {
  return {
    id: id ?? randomUUID(),
    executable: probe.executable,
    major: probe.major,
    version: probe.version,
    vendor: probe.vendor,
    arch: probe.arch,
    source,
    lastVerifiedAt: now,
  };
}

function key(p: string) {
  return path.resolve(p).toLowerCase();
}

export function commonTopFolder(names: string[]): string | null {
  const firsts = new Set(names.map((n) => n.split("/")[0] + "/"));
  if (firsts.size !== 1) return null;
  const [top] = firsts;
  return names.every((n) => n.startsWith(top)) ? top : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
