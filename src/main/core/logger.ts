/**
 * Central application logger. Writes one file per day under the logs folder,
 * keeps a ring buffer for the Diagnostics screen, and redacts secrets before
 * anything is written or shown.
 */
import fs from "node:fs";
import path from "node:path";
import type { LogEntry, LogLevel } from "../../shared/ipc";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Patterns that look like credentials even when nobody registered them. */
const SECRET_PATTERNS: RegExp[] = [
  /\$2a\$10\$[./A-Za-z0-9]{53}/g, // CurseForge API keys
  /(rcon\.password\s*[=:]\s*)\S+/gi,
  /(x-api-key\s*[:=]\s*)\S+/gi,
  /(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi,
];

export class Logger {
  private readonly buffer: LogEntry[] = [];
  private readonly secrets = new Set<string>();
  private readonly listeners = new Set<(entry: LogEntry) => void>();

  constructor(
    private readonly dir: string | null,
    private readonly minLevel: LogLevel = "info",
    private readonly bufferSize = 2000,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  /** Register a secret value so it is replaced with *** wherever it appears. */
  addSecret(value: string | null | undefined) {
    if (value && value.length >= 4) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("***");
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, (_m, prefix?: string) => (typeof prefix === "string" ? `${prefix}***` : "***"));
    }
    return out;
  }

  scope(name: string) {
    return {
      debug: (msg: string) => this.write("debug", name, msg),
      info: (msg: string) => this.write("info", name, msg),
      warn: (msg: string) => this.write("warn", name, msg),
      error: (msg: string, err?: unknown) => this.write("error", name, err ? `${msg}: ${describeError(err)}` : msg),
    };
  }

  write(level: LogLevel, scope: string, message: string) {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const entry: LogEntry = { at: this.now().toISOString(), level, scope, message: this.redact(message) };
    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    if (this.dir) {
      const file = path.join(this.dir, `nexcraft-${entry.at.slice(0, 10)}.log`);
      try {
        fs.appendFileSync(file, `${entry.at} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.message}\n`, "utf8");
      } catch {
        // A full or read-only disk must not crash the app; the entry stays in memory.
      }
    }
    for (const fn of this.listeners) fn(entry);
  }

  recent(limit: number): LogEntry[] {
    return this.buffer.slice(-limit);
  }

  onEntry(fn: (entry: LogEntry) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Delete log files older than `days`. Only touches files this logger names. */
  prune(days = 14) {
    if (!this.dir) return;
    const cutoff = this.now().getTime() - days * 86_400_000;
    for (const name of fs.readdirSync(this.dir)) {
      const m = /^nexcraft-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type ScopedLogger = ReturnType<Logger["scope"]>;
