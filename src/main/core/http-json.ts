/**
 * Fetch small JSON documents (version manifests, API responses) over HTTPS with a
 * timeout, a size cap, an optional SHA-1 check, and an optional on-disk cache so
 * NexCraft keeps working offline with what it last saw.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateDownloadUrl } from "./download-queue";

export interface JsonFetchOptions {
  userAgent: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  sha1?: string;
  headers?: Record<string, string>;
  /** Cache file path. Fresh copies are written here; it is read when offline. */
  cacheFile?: string;
  /** Serve the cache without a request while it is younger than this. */
  cacheTtlMs?: number;
  insecureHosts?: string[];
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function fetchJson<T = unknown>(url: string, opts: JsonFetchOptions): Promise<{ data: T; fromCache: boolean }> {
  if (opts.cacheFile && opts.cacheTtlMs) {
    try {
      const st = fs.statSync(opts.cacheFile);
      if (Date.now() - st.mtimeMs < opts.cacheTtlMs) return { data: JSON.parse(fs.readFileSync(opts.cacheFile, "utf8")) as T, fromCache: true };
    } catch {
      // No usable cache; fetch.
    }
  }
  try {
    const text = await fetchText(url, opts);
    const data = JSON.parse(text) as T;
    if (opts.cacheFile) {
      fs.mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
      const tmp = `${opts.cacheFile}.tmp`;
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, opts.cacheFile);
    }
    return { data, fromCache: false };
  } catch (err) {
    if (opts.cacheFile && !(err instanceof HttpError && err.status >= 400 && err.status < 500) && fs.existsSync(opts.cacheFile)) {
      return { data: JSON.parse(fs.readFileSync(opts.cacheFile, "utf8")) as T, fromCache: true };
    }
    throw err;
  }
}

export async function fetchText(url: string, opts: JsonFetchOptions): Promise<string> {
  validateDownloadUrl(url, opts.insecureHosts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      headers: { "user-agent": opts.userAgent, accept: "application/json", ...opts.headers },
      signal: controller.signal,
      redirect: "follow",
    });
    if (res.url) validateDownloadUrl(res.url, opts.insecureHosts);
    if (!res.ok) throw new HttpError(`${new URL(url).hostname} answered ${res.status}`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > (opts.maxBytes ?? 32 * 1024 * 1024)) throw new HttpError("Response is too large", 0);
    if (opts.sha1) {
      const actual = createHash("sha1").update(buf).digest("hex");
      if (actual !== opts.sha1.toLowerCase()) throw new HttpError(`Checksum mismatch for ${url}`, 0);
    }
    return buf.toString("utf8");
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new HttpError(`Timed out contacting ${new URL(url).hostname}`, 0);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
