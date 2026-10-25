/**
 * Server backups: ZIP archives of a server's worlds, mods, configs and settings.
 *
 * - A running server is asked to stop writing (`save-off`) and flush its world
 *   (`save-all flush`) first, and saving is switched back on afterwards. If the
 *   server does not confirm the flush, no backup is taken.
 * - Every archive is read back in full and checked against its checksums before
 *   it counts. Unfinished archives keep a ".partial" name and are never listed.
 * - Retention trims old scheduled and safety backups, but never the newest
 *   verified backup, so a server cannot be left without a good one.
 * - Restoring needs the server stopped, takes a safety backup first, unpacks
 *   into a temporary folder, then swaps items in, rolling back on any error.
 *
 * Server software (libraries, the server and loader jars) and logs are left
 * out; they stay in place on restore and can be reinstalled.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import type { BackupInfo, BackupKind, RestorePreview } from "../../shared/backups";
import type { ServerInstance } from "../../shared/model";
import { extractZip, listZip, verifyZip } from "../core/archive";
import type { ScopedLogger } from "../core/logger";
import { resolveInside, toSafeName } from "../core/safe-path";
import type { ServerService } from "../servers/server-service";
import type { StateService } from "../services/state-service";

export interface BackupServiceDeps {
  state: Pick<StateService, "server" | "servers" | "upsertServer">;
  servers: Pick<ServerService, "status" | "commandAndWait">;
  backupsDir: () => string;
  log: ScopedLogger;
  /** Called after backups of a server change, so the UI can refresh. */
  onChange?: (serverId: string) => void;
  now?: () => Date;
  /** How long to wait for the server to confirm it saved. */
  saveTimeoutMs?: number;
}

const MANIFEST = "nexcraft-backup.json";
const KEEP_SAFETY = 3;
/** Already-compressed formats are stored as they are; compressing them again only costs time. */
const STORE_ONLY = /\.(mca|mcr|jar|zip|png|jpg|ogg|gz|dat_old)$/i;
const SKIP_TOP_DIRS = new Set(["logs", "libraries", "versions", "cache", ".fabric", ".quilt", ".mixin.out"]);

/** Paths (relative, "/"-separated) that backups leave out. */
export function excludedFromBackup(rel: string, isDir: boolean): boolean {
  const parts = rel.split("/");
  const top = parts[0];
  if (parts.length === 1 && isDir && SKIP_TOP_DIRS.has(top)) return true;
  if (parts.length === 1 && !isDir && /\.(jar|log)$/i.test(top)) return true;
  if (top === ".nexcraft" && (parts[1] === "mod-history" || parts[1]?.startsWith("restore-"))) return true;
  // The server holds session.lock open while running; it has no data in it.
  if (parts.at(-1) === "session.lock") return true;
  return false;
}

interface FileEntry {
  abs: string;
  rel: string;
  size: number;
  mtime: Date;
}

export class BackupService {
  private readonly busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: BackupServiceDeps) {}

  // ---- listing -------------------------------------------------------------

  list(serverId: string): BackupInfo[] {
    const root = this.rootFor(serverId);
    if (!fs.existsSync(root)) return [];
    const out: BackupInfo[] = [];
    for (const name of fs.readdirSync(root)) {
      if (name.endsWith(".partial")) {
        // Left over from a backup that was interrupted; it was never complete.
        fs.rmSync(path.join(root, name), { force: true });
        continue;
      }
      if (!name.endsWith(".json")) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as BackupInfo;
        if (fs.existsSync(path.join(root, `${info.id}.zip`))) out.push(info);
      } catch {
        // Not one of ours.
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Absolute path of a backup archive, for "show in folder". */
  archivePath(serverId: string, backupId: string): string {
    return this.zipFor(serverId, backupId);
  }

  // ---- creating ------------------------------------------------------------

  async create(serverId: string, opts: { kind: BackupKind; note?: string }): Promise<BackupInfo> {
    return this.exclusive(serverId, () => this.createUnlocked(serverId, opts));
  }

  private async createUnlocked(serverId: string, opts: { kind: BackupKind; note?: string }): Promise<BackupInfo> {
    const server = this.need(serverId);
    const root = this.rootFor(server.id);
    fs.mkdirSync(root, { recursive: true });
    const now = (this.deps.now ?? (() => new Date()))();
    // Ids travel through IPC and become file names, so they keep to letters, digits, "-", "_" and ".".
    const label = toSafeName(server.name, "server").replace(/[^\w.-]+/g, "-").replace(/^[-.]+/, "") || "server";
    const id = `${label}-${now.toISOString().replace(/[:.]/g, "-")}${opts.kind === "safety" ? "-before-restore" : ""}`;
    const zipPath = path.join(root, `${id}.zip`);
    const partial = `${zipPath}.partial`;
    const state = this.deps.servers.status(server.id).state;
    const running = state === "running" || state === "starting";
    const timeout = this.deps.saveTimeoutMs ?? 120_000;

    let savingOff = false;
    try {
      if (running) {
        savingOff = await this.deps.servers.commandAndWait(server.id, "save-off", /Automatic saving is now disabled|Saving is already turned off/i, 15_000);
        const flushed = await this.deps.servers.commandAndWait(server.id, "save-all flush", /Saved the game/i, timeout);
        if (!flushed) throw new Error(`${server.name} did not confirm that it saved the world, so no backup was taken. Try again, or stop the server first.`);
      }
      const files = this.walk(server.directory);
      const info: BackupInfo = {
        id,
        serverId: server.id,
        serverName: server.name,
        createdAt: now.toISOString(),
        kind: opts.kind,
        note: (opts.note ?? "").slice(0, 200),
        minecraftVersion: server.minecraftVersion,
        type: server.type,
        loaderVersion: server.loaderVersion,
        files: files.length,
        bytes: files.reduce((n, f) => n + f.size, 0),
        sizeOnDisk: 0,
        verified: false,
        savedWhileRunning: running,
      };
      await this.writeZip(partial, files, info);
      if (savingOff) {
        await this.deps.servers.commandAndWait(server.id, "save-on", /Automatic saving is now enabled|Saving is already turned on/i, 15_000);
        savingOff = false;
      }

      const check = await verifyZip(partial);
      if (check.entries !== files.length + 1) throw new Error(`The backup archive holds ${check.entries - 1} of ${files.length} files`);
      fs.renameSync(partial, zipPath);
      info.verified = true;
      info.sizeOnDisk = fs.statSync(zipPath).size;
      writeJson(path.join(root, `${id}.json`), info);

      if (opts.kind !== "safety") {
        const latest = this.deps.state.server(server.id);
        if (latest) this.deps.state.upsertServer({ ...latest, lastBackupAt: info.createdAt });
      }
      this.applyRetention(server.id);
      this.deps.log.info(`Backed up ${server.name} (${info.files} files) to ${zipPath}`);
      this.deps.onChange?.(server.id);
      return info;
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    } finally {
      if (savingOff) await this.deps.servers.commandAndWait(server.id, "save-on", /Automatic saving is now enabled|Saving is already turned on/i, 15_000);
    }
  }

  private walk(root: string): FileEntry[] {
    const out: FileEntry[] = [];
    const stack = [""];
    while (stack.length) {
      const rel = stack.pop()!;
      const dir = rel ? path.join(root, rel) : root;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        // Links are not followed: they could point outside the server folder.
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) {
          if (!excludedFromBackup(childRel, true)) stack.push(childRel);
        } else if (d.isFile() && !excludedFromBackup(childRel, false)) {
          const abs = path.join(root, ...childRel.split("/"));
          const st = fs.statSync(abs);
          out.push({ abs, rel: childRel, size: st.size, mtime: st.mtime });
        }
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  private async writeZip(dest: string, files: FileEntry[], info: BackupInfo) {
    const zip = new yazl.ZipFile();
    const failed = new Promise<never>((_, reject) => zip.on("error", reject));
    failed.catch(() => undefined);
    for (const f of files) {
      // The size is checked as the file is read, so a file that changes underneath fails the backup.
      zip.addReadStreamLazy(f.rel, { mtime: f.mtime, size: f.size, compress: !STORE_ONLY.test(f.rel) }, (cb) => {
        const stream = fs.createReadStream(f.abs);
        stream.once("open", () => cb(null, stream));
        stream.once("error", (err) => cb(new Error(`Could not read ${f.rel}: ${err.message}`), stream));
      });
    }
    zip.addBuffer(Buffer.from(JSON.stringify({ ...info, verified: undefined, sizeOnDisk: undefined }, null, 2)), MANIFEST);
    zip.end();
    await Promise.race([pipeline(zip.outputStream, fs.createWriteStream(dest, { flags: "wx" })), failed]);
  }

  // ---- retention -----------------------------------------------------------

  /** Trim scheduled backups to the server's limit and safety backups to a few, keeping the newest verified one. */
  private applyRetention(serverId: string) {
    const server = this.deps.state.server(serverId);
    if (!server) return;
    const all = this.list(serverId);
    const newestGood = all.find((b) => b.verified);
    const drop = [
      ...all.filter((b) => b.kind === "scheduled").slice(server.backupSchedule.keep),
      ...all.filter((b) => b.kind === "safety").slice(KEEP_SAFETY),
    ].filter((b) => b !== newestGood);
    for (const b of drop) this.removeFiles(serverId, b.id);
  }

  delete(serverId: string, backupId: string) {
    if (this.busy.has(serverId)) throw new Error("Wait for the current backup or restore to finish.");
    this.zipFor(serverId, backupId);
    this.removeFiles(serverId, backupId);
    this.deps.onChange?.(serverId);
  }

  private removeFiles(serverId: string, backupId: string) {
    const root = this.rootFor(serverId);
    fs.rmSync(resolveInside(root, `${backupId}.zip`), { force: true });
    fs.rmSync(resolveInside(root, `${backupId}.json`), { force: true });
  }

  // ---- restoring -----------------------------------------------------------

  async preview(serverId: string, backupId: string): Promise<RestorePreview> {
    const server = this.need(serverId);
    const backup = this.find(serverId, backupId);
    const entries = (await listZip(this.zipFor(serverId, backupId))).map((e) => e.name).filter((n) => n !== MANIFEST);
    const inBackup = new Set(entries.map((n) => n.split("/")[0]).filter(Boolean));
    const current = fs.existsSync(server.directory)
      ? fs
          .readdirSync(server.directory, { withFileTypes: true })
          .filter((d) => !excludedFromBackup(d.name, d.isDirectory()))
          .map((d) => d.name)
      : [];
    const warnings: string[] = [];
    if (backup.minecraftVersion !== server.minecraftVersion || backup.type !== server.type) {
      warnings.push(
        `This backup was made on Minecraft ${backup.minecraftVersion} (${backup.type}); the server now runs ${server.minecraftVersion} (${server.type}). Worlds saved by a newer version cannot be opened by an older one.`,
      );
    }
    const state = this.deps.servers.status(serverId).state;
    if (state !== "stopped" && state !== "crashed") warnings.push(`Stop ${server.name} before restoring.`);
    return {
      backup,
      replaces: [...inBackup].filter((n) => current.includes(n)).sort(),
      adds: [...inBackup].filter((n) => !current.includes(n)).sort(),
      keeps: current.filter((n) => !inBackup.has(n)).sort(),
      warnings,
    };
  }

  async restore(serverId: string, backupId: string): Promise<{ safetyBackupId: string }> {
    return this.exclusive(serverId, async () => {
      const server = this.need(serverId);
      const state = this.deps.servers.status(serverId).state;
      if (state !== "stopped" && state !== "crashed") throw new Error(`Stop ${server.name} before restoring a backup.`);
      const zipPath = this.zipFor(serverId, backupId);
      this.find(serverId, backupId);
      // Check the archive before touching anything.
      await verifyZip(zipPath);
      const safety = await this.createUnlocked(serverId, { kind: "safety", note: "Made automatically before a restore" });

      const work = path.join(server.directory, ".nexcraft", `restore-${randomUUID().slice(0, 8)}`);
      const incoming = path.join(work, "new");
      const old = path.join(work, "old");
      fs.mkdirSync(old, { recursive: true });
      await extractZip(zipPath, incoming, {
        filter: (n) => n !== MANIFEST,
        limits: { maxEntries: 1_000_000, maxTotalBytes: 512 * 1024 ** 3, maxRatio: 10_000 },
      });

      const done: { name: string; hadOld: boolean }[] = [];
      try {
        for (const name of fs.readdirSync(incoming)) {
          if (name === ".nexcraft") continue;
          const target = path.join(server.directory, name);
          const hadOld = fs.existsSync(target);
          if (hadOld) fs.renameSync(target, path.join(old, name));
          done.push({ name, hadOld });
          fs.renameSync(path.join(incoming, name), target);
        }
        // NexCraft's own records (mod sources, manual downloads) are merged file by file, so mod history survives.
        const meta = path.join(incoming, ".nexcraft");
        if (fs.existsSync(meta)) fs.cpSync(meta, path.join(server.directory, ".nexcraft"), { recursive: true, force: true });
      } catch (err) {
        for (const { name, hadOld } of done.reverse()) {
          const target = path.join(server.directory, name);
          try {
            if (fs.existsSync(path.join(old, name)) || !hadOld) fs.rmSync(target, { recursive: true, force: true });
            if (hadOld && fs.existsSync(path.join(old, name))) fs.renameSync(path.join(old, name), target);
          } catch (rollbackErr) {
            this.deps.log.error(`Could not roll back ${name}: ${(rollbackErr as Error).message}`);
          }
        }
        throw new Error(`Restoring failed and the server folder was put back as it was: ${(err as Error).message}. A safety backup (${safety.id}) was also made.`);
      }
      fs.rmSync(work, { recursive: true, force: true });
      this.deps.log.info(`Restored ${server.name} from ${backupId}; safety backup ${safety.id}`);
      this.deps.onChange?.(serverId);
      return { safetyBackupId: safety.id };
    });
  }

  // ---- schedule ------------------------------------------------------------

  setSchedule(serverId: string, schedule: ServerInstance["backupSchedule"]): ServerInstance {
    const server = this.need(serverId);
    const next = { ...server, backupSchedule: schedule };
    this.deps.state.upsertServer(next);
    this.applyRetention(serverId);
    return next;
  }

  /** Check once a minute for servers whose automatic backup is due. */
  start(intervalMs = 60_000) {
    this.stop();
    this.timer = setInterval(() => void this.runDue(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runDue() {
    const now = (this.deps.now ?? (() => new Date()))().getTime();
    for (const server of this.deps.state.servers()) {
      const hours = server.backupSchedule.everyHours;
      if (!hours || this.busy.has(server.id)) continue;
      const last = Date.parse(server.lastBackupAt ?? server.createdAt);
      if (now - last < hours * 3_600_000) continue;
      try {
        await this.create(server.id, { kind: "scheduled" });
      } catch (err) {
        this.deps.log.warn(`Scheduled backup of ${server.name} failed: ${(err as Error).message}`);
      }
    }
  }

  // ---- helpers -------------------------------------------------------------

  private async exclusive<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(serverId)) throw new Error("A backup or restore of this server is already running.");
    this.busy.add(serverId);
    try {
      return await fn();
    } finally {
      this.busy.delete(serverId);
    }
  }

  private need(id: string): ServerInstance {
    const server = this.deps.state.server(id);
    if (!server) throw new Error("That server no longer exists");
    return server;
  }

  private rootFor(serverId: string) {
    return resolveInside(this.deps.backupsDir(), toSafeName(serverId, "server"));
  }

  private zipFor(serverId: string, backupId: string) {
    if (!/^[\w.-]+$/.test(backupId)) throw new Error("That backup does not exist");
    const file = resolveInside(this.rootFor(serverId), `${backupId}.zip`);
    if (!fs.existsSync(file)) throw new Error("That backup no longer exists");
    return file;
  }

  private find(serverId: string, backupId: string): BackupInfo {
    const info = this.list(serverId).find((b) => b.id === backupId);
    if (!info) throw new Error("That backup no longer exists");
    return info;
  }
}

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
