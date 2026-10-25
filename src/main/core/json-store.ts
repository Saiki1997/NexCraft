/**
 * A small versioned JSON file store.
 *
 * - Writes are atomic: data goes to a temp file, is flushed, then renamed over the
 *   real file, and the previous good copy is kept as `<file>.bak`.
 * - Loads run migrations from the stored `schemaVersion` up to the current one and
 *   validate the result. A file that cannot be parsed, migrated or validated is
 *   moved aside (never deleted) and the store falls back to `.bak`, then defaults.
 */
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";

export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

export interface JsonStoreOptions<T> {
  file: string;
  schema: z.ZodType<T>;
  currentVersion: number;
  /** migrations[n] upgrades data from schemaVersion n to n + 1. */
  migrations?: Record<number, Migration>;
  defaults: () => T;
  now?: () => Date;
}

export interface LoadResult<T> {
  value: T;
  /** Where the loaded value came from. */
  source: "file" | "backup" | "defaults";
  /** Path the unreadable file was moved to, when recovery happened. */
  quarantined: string | null;
  problem: string | null;
}

export class JsonStore<T> {
  private readonly opts: JsonStoreOptions<T>;

  constructor(opts: JsonStoreOptions<T>) {
    this.opts = opts;
  }

  get file() {
    return this.opts.file;
  }

  load(): LoadResult<T> {
    const { file } = this.opts;
    if (!fs.existsSync(file)) {
      const fromBackup = this.tryRead(`${file}.bak`);
      if (fromBackup.ok) return { value: fromBackup.value, source: "backup", quarantined: null, problem: "Main state file was missing" };
      return { value: this.opts.defaults(), source: "defaults", quarantined: null, problem: null };
    }
    const main = this.tryRead(file);
    if (main.ok) return { value: main.value, source: "file", quarantined: null, problem: null };

    const quarantined = this.quarantine(file);
    const fromBackup = this.tryRead(`${file}.bak`);
    if (fromBackup.ok) return { value: fromBackup.value, source: "backup", quarantined, problem: main.error };
    return { value: this.opts.defaults(), source: "defaults", quarantined, problem: main.error };
  }

  save(value: T): void {
    const parsed = this.opts.schema.parse(value);
    const { file } = this.opts;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const body = JSON.stringify(parsed, null, 2);
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, body, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(file) && this.tryRead(file).ok) fs.copyFileSync(file, `${file}.bak`);
    fs.renameSync(tmp, file);
  }

  private tryRead(file: string): { ok: true; value: T } | { ok: false; error: string } {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      return { ok: false, error: `Could not read ${path.basename(file)}: ${(err as Error).message}` };
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `${path.basename(file)} is not valid JSON: ${(err as Error).message}` };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: `${path.basename(file)} does not contain an object` };
    }
    let record = data as Record<string, unknown>;
    const stored = typeof record.schemaVersion === "number" ? record.schemaVersion : 0;
    if (stored > this.opts.currentVersion) {
      return { ok: false, error: `${path.basename(file)} was written by a newer NexCraft (schema ${stored})` };
    }
    try {
      for (let v = stored; v < this.opts.currentVersion; v++) {
        const migrate = this.opts.migrations?.[v];
        if (!migrate) return { ok: false, error: `No migration from schema ${v}` };
        record = { ...migrate(record), schemaVersion: v + 1 };
      }
    } catch (err) {
      return { ok: false, error: `Migration failed: ${(err as Error).message}` };
    }
    const result = this.opts.schema.safeParse(record);
    if (!result.success) {
      const first = result.error.issues[0];
      return { ok: false, error: `${path.basename(file)} failed validation at ${first?.path.join(".") || "(root)"}: ${first?.message}` };
    }
    return { ok: true, value: result.data };
  }

  private quarantine(file: string): string {
    const stamp = (this.opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const target = `${file}.corrupt-${stamp}`;
    fs.renameSync(file, target);
    return target;
  }
}
