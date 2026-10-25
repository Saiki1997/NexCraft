/**
 * Download queue: bounded concurrency, HTTPS only, retries with backoff, resume
 * from a `.part` file, size and hash verification, cancellation, and an atomic
 * rename into place only after verification passes.
 */
import { createHash, randomUUID, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Job } from "../../shared/model";
import type { ScopedLogger } from "./logger";

export type HashAlgo = "sha1" | "sha256" | "sha512";

export interface DownloadRequest {
  url: string;
  /** Absolute destination path. Callers are responsible for containment checks. */
  dest: string;
  title: string;
  hash?: { algo: HashAlgo; value: string };
  size?: number;
  serverId?: string | null;
  headers?: Record<string, string>;
}

export type DownloadOutcome = { ok: true; path: string; bytes: number } | { ok: false; error: string; cancelled: boolean };

export interface DownloadQueueOptions {
  fetch?: typeof fetch;
  concurrency?: number;
  userAgent: string;
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
  log?: ScopedLogger;
  now?: () => Date;
  /** Hosts allowed over plain HTTP. Only meant for tests against a local server. */
  insecureHosts?: string[];
  onChange?: (jobs: Job[]) => void;
}

class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface Entry {
  job: Job;
  req: DownloadRequest;
  abort: AbortController;
  resolve: (outcome: DownloadOutcome) => void;
  promise: Promise<DownloadOutcome>;
}

export function validateDownloadUrl(raw: string, insecureHosts: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DownloadError(`Not a valid URL: ${raw}`, false);
  }
  if (url.username || url.password) throw new DownloadError("URLs with embedded credentials are not allowed", false);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && insecureHosts.includes(url.hostname)) return url;
  throw new DownloadError(`Only HTTPS downloads are allowed (got ${url.protocol}//${url.hostname})`, false);
}

export class DownloadQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly order: string[] = [];
  private running = 0;
  private concurrency: number;
  private readonly fetchImpl: typeof fetch;
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: DownloadQueueOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.concurrency = opts.concurrency ?? 3;
  }

  setConcurrency(n: number) {
    this.concurrency = Math.max(1, Math.min(8, Math.floor(n)));
    this.pump();
  }

  jobs(): Job[] {
    return this.order.map((id) => ({ ...this.entries.get(id)!.job }));
  }

  enqueue(req: DownloadRequest): { job: Job; done: Promise<DownloadOutcome> } {
    const now = this.stamp();
    const job: Job = {
      id: randomUUID(),
      kind: "download",
      title: req.title,
      status: "queued",
      serverId: req.serverId ?? null,
      createdAt: now,
      updatedAt: now,
      progress: null,
      bytesDone: 0,
      bytesTotal: req.size ?? null,
      error: null,
      resumable: true,
    };
    let resolve!: (o: DownloadOutcome) => void;
    const promise = new Promise<DownloadOutcome>((r) => (resolve = r));
    const entry: Entry = { job, req, abort: new AbortController(), resolve, promise };
    this.entries.set(job.id, entry);
    this.order.push(job.id);

    try {
      validateDownloadUrl(req.url, this.opts.insecureHosts);
    } catch (err) {
      this.finish(entry, "failed", (err as Error).message);
      return { job: { ...job }, done: promise };
    }
    this.emit(true);
    this.pump();
    return { job: { ...job }, done: promise };
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !["queued", "running"].includes(entry.job.status)) return false;
    entry.abort.abort();
    if (entry.job.status === "queued") this.finish(entry, "cancelled", "Cancelled");
    return true;
  }

  /** Cancel everything still waiting or running; used on app quit. */
  cancelAll() {
    for (const id of this.order) this.cancel(id);
  }

  clearFinished() {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const e = this.entries.get(this.order[i])!;
      if (!["queued", "running"].includes(e.job.status)) {
        this.entries.delete(e.job.id);
        this.order.splice(i, 1);
      }
    }
    this.emit(true);
  }

  private pump() {
    while (this.running < this.concurrency) {
      const next = this.order.map((id) => this.entries.get(id)!).find((e) => e.job.status === "queued");
      if (!next) return;
      this.running++;
      this.update(next, { status: "running" });
      void this.run(next).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(entry: Entry) {
    const maxAttempts = this.opts.maxAttempts ?? 4;
    const delay = this.opts.retryDelayMs ?? ((n: number) => Math.min(30_000, 1000 * 2 ** (n - 1)));
    for (let attempt = 1; ; attempt++) {
      try {
        const bytes = await this.attempt(entry);
        this.finish(entry, "succeeded", null);
        entry.resolve({ ok: true, path: entry.req.dest, bytes });
        return;
      } catch (err) {
        if (entry.abort.signal.aborted) {
          this.cleanupPart(entry);
          this.finish(entry, "cancelled", "Cancelled");
          return;
        }
        const retryable = err instanceof DownloadError ? err.retryable : true;
        const message = (err as Error).message || String(err);
        if (!retryable || attempt >= maxAttempts) {
          this.opts.log?.warn(`Download failed after ${attempt} attempt(s): ${entry.req.title}: ${message}`);
          this.finish(entry, "failed", message);
          return;
        }
        this.opts.log?.info(`Retrying ${entry.req.title} (attempt ${attempt + 1}/${maxAttempts}): ${message}`);
        await sleep(delay(attempt), entry.abort.signal).catch(() => undefined);
        if (entry.abort.signal.aborted) {
          this.cleanupPart(entry);
          this.finish(entry, "cancelled", "Cancelled");
          return;
        }
      }
    }
  }

  private async attempt(entry: Entry): Promise<number> {
    const { req } = entry;
    const part = `${req.dest}.part`;
    fs.mkdirSync(path.dirname(req.dest), { recursive: true });

    let existing = 0;
    try {
      existing = fs.statSync(part).size;
    } catch {
      existing = 0;
    }
    if (req.size != null && existing > req.size) {
      fs.rmSync(part, { force: true });
      existing = 0;
    }

    const headers: Record<string, string> = { "user-agent": this.opts.userAgent, ...req.headers };
    if (existing > 0) headers.range = `bytes=${existing}-`;

    const res = await this.fetchFollowingSafeRedirects(req.url, headers, entry.abort.signal);

    if (res.status === 416 && existing > 0) {
      // Our partial file is already complete or the server disagrees; start over.
      fs.rmSync(part, { force: true });
      throw new DownloadError("Server rejected the resume range", true);
    }
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      throw new DownloadError(`Server answered ${res.status} ${res.statusText}`.trim(), retryable);
    }
    if (!res.body) throw new DownloadError("Empty response body", true);

    const resumed = res.status === 206 && existing > 0;
    if (!resumed) existing = 0;
    const hasher = req.hash ? createHash(req.hash.algo) : null;
    if (hasher && resumed) await hashFile(part, hasher);

    const lengthHeader = Number(res.headers.get("content-length"));
    const total = req.size ?? (Number.isFinite(lengthHeader) && lengthHeader > 0 ? existing + lengthHeader : null);
    this.update(entry, { bytesDone: existing, bytesTotal: total, progress: total ? existing / total : null }, false);

    const out = fs.createWriteStream(part, { flags: resumed ? "a" : "w" });
    let done = existing;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        hasher?.update(value);
        done += value.byteLength;
        if (req.size != null && done > req.size) throw new DownloadError("Download is larger than expected", false);
        this.update(entry, { bytesDone: done, progress: total ? Math.min(1, done / total) : null }, false);
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }

    if (req.size != null && done !== req.size) {
      throw new DownloadError(`Size mismatch: expected ${req.size} bytes, got ${done}`, true);
    }
    if (hasher && req.hash) {
      const actual = hasher.digest("hex");
      if (actual.toLowerCase() !== req.hash.value.toLowerCase()) {
        fs.rmSync(part, { force: true });
        throw new DownloadError(`${req.hash.algo} mismatch: expected ${req.hash.value}, got ${actual}`, true);
      }
    }
    fs.renameSync(part, req.dest);
    this.update(entry, { bytesDone: done, bytesTotal: done, progress: 1 }, false);
    return done;
  }

  /** Follow redirects ourselves so every hop is checked before it is requested. */
  private async fetchFollowingSafeRedirects(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      validateDownloadUrl(current, this.opts.insecureHosts);
      let res: Response;
      try {
        res = await this.fetchImpl(current, { headers, signal, redirect: "manual" });
      } catch (err) {
        throw new DownloadError(`Network error: ${(err as Error).message}`, true);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => undefined);
        current = new URL(res.headers.get("location")!, current).toString();
        continue;
      }
      return res;
    }
    throw new DownloadError("Too many redirects", false);
  }

  private cleanupPart(entry: Entry) {
    fs.rmSync(`${entry.req.dest}.part`, { force: true });
  }

  private finish(entry: Entry, status: Job["status"], error: string | null) {
    this.update(entry, { status, error }, true);
    if (status !== "succeeded") entry.resolve({ ok: false, error: error ?? status, cancelled: status === "cancelled" });
  }

  private update(entry: Entry, patch: Partial<Job>, force = true) {
    Object.assign(entry.job, patch, { updatedAt: this.stamp() });
    this.emit(force);
  }

  private emit(force: boolean) {
    if (!this.opts.onChange) return;
    const now = Date.now();
    if (force || now - this.lastEmit >= 250) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.lastEmit = now;
      this.opts.onChange(this.jobs());
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => this.emit(true), 250);
    }
  }

  private stamp() {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }
}

async function hashFile(file: string, hasher: Hash) {
  for await (const chunk of fs.createReadStream(file)) hasher.update(chunk as Buffer);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}
