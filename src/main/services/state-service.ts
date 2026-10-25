/**
 * Owns NexCraft's persisted state (settings, servers, Java runtimes, job history)
 * and is the only module that reads or writes the state file.
 */
import path from "node:path";
import type { SettingsPatch, SettingsView } from "../../shared/ipc";
import { AppStateSchema, defaultAppState, MAX_FINISHED_JOBS, SCHEMA_VERSION, type AppState, type Job, type ServerInstance } from "../../shared/model";
import { JsonStore, type LoadResult } from "../core/json-store";
import type { ScopedLogger } from "../core/logger";

/** Electron's safeStorage in the app; a fake in tests. */
export interface SecretSealer {
  available(): boolean;
  seal(plain: string): string;
  unseal(sealed: string): string;
}

export class StateService {
  private state: AppState;
  private readonly store: JsonStore<AppState>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  readonly loadResult: LoadResult<AppState>;

  constructor(
    dataDir: string,
    private readonly sealer: SecretSealer,
    private readonly log: ScopedLogger,
    private readonly saveDelayMs = 300,
  ) {
    this.store = new JsonStore<AppState>({
      file: path.join(dataDir, "nexcraft-state.json"),
      schema: AppStateSchema,
      currentVersion: SCHEMA_VERSION,
      migrations: {},
      defaults: defaultAppState,
    });
    this.loadResult = this.store.load();
    this.state = this.loadResult.value;
    if (this.loadResult.problem) {
      this.log.warn(
        `State recovered from ${this.loadResult.source}: ${this.loadResult.problem}` +
          (this.loadResult.quarantined ? ` (unreadable file kept at ${this.loadResult.quarantined})` : ""),
      );
    }
    this.recoverJobs();
  }

  /** Jobs that were mid-flight when NexCraft last closed cannot still be running. */
  private recoverJobs() {
    let changed = false;
    const now = new Date().toISOString();
    this.state.jobs = this.state.jobs.map((job) => {
      if (job.status === "running" || job.status === "queued") {
        changed = true;
        return { ...job, status: "interrupted", updatedAt: now, error: "NexCraft closed before this finished" };
      }
      return job;
    });
    if (changed) {
      this.log.info("Marked unfinished jobs from the last session as interrupted");
      this.saveNow();
    }
  }

  snapshot(): AppState {
    return structuredClone(this.state);
  }

  settingsView(): SettingsView {
    const { curseforgeKeyOverride, ...rest } = this.state.settings;
    return { ...rest, hasCurseforgeKeyOverride: curseforgeKeyOverride != null };
  }

  updateSettings(patch: SettingsPatch): SettingsView {
    this.state.settings = { ...this.state.settings, ...patch };
    this.scheduleSave();
    return this.settingsView();
  }

  setCurseforgeKey(key: string | null): SettingsView {
    if (key) {
      if (!this.sealer.available()) throw new Error("Windows secure storage is not available, so the key cannot be saved safely");
      this.state.settings.curseforgeKeyOverride = { sealed: this.sealer.seal(key) };
    } else {
      this.state.settings.curseforgeKeyOverride = null;
    }
    this.scheduleSave();
    return this.settingsView();
  }

  curseforgeKeyOverride(): string | null {
    const sealed = this.state.settings.curseforgeKeyOverride;
    if (!sealed) return null;
    try {
      return this.sealer.unseal(sealed.sealed);
    } catch (err) {
      this.log.warn(`Stored CurseForge key could not be decrypted and was ignored: ${(err as Error).message}`);
      return null;
    }
  }

  servers(): ServerInstance[] {
    return structuredClone(this.state.servers);
  }

  jobs(): Job[] {
    return structuredClone(this.state.jobs);
  }

  /** Merge live job records into history, keeping only the newest finished ones. */
  recordJobs(live: Job[]) {
    const byId = new Map(this.state.jobs.map((j) => [j.id, j]));
    for (const job of live) byId.set(job.id, job);
    const all = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const active = all.filter((j) => j.status === "queued" || j.status === "running");
    const finished = all.filter((j) => !(j.status === "queued" || j.status === "running")).slice(-MAX_FINISHED_JOBS);
    this.state.jobs = [...finished, ...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.scheduleSave();
  }

  clearFinishedJobs(): Job[] {
    this.state.jobs = this.state.jobs.filter((j) => j.status === "queued" || j.status === "running");
    this.scheduleSave();
    return this.jobs();
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), this.saveDelayMs);
  }

  saveNow() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      this.store.save(this.state);
    } catch (err) {
      this.log.error("Could not save NexCraft state", err);
    }
  }
}
