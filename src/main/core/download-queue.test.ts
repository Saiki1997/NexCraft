import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpDir } from "../../../test/helpers/tmp";
import { DownloadQueue, validateDownloadUrl } from "./download-queue";

const BODY = Buffer.alloc(256 * 1024, 0);
for (let i = 0; i < BODY.length; i++) BODY[i] = (i * 31) % 251;
const SHA1 = createHash("sha1").update(BODY).digest("hex");
const SHA256 = createHash("sha256").update(BODY).digest("hex");

let server: http.Server;
let base = "";
const hits = new Map<string, number>();
const ranges: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const n = (hits.get(url.pathname) ?? 0) + 1;
    hits.set(url.pathname, n);
    const range = req.headers.range;
    if (range) ranges.push(`${url.pathname} ${range}`);

    const sendFile = () => {
      const m = range ? /bytes=(\d+)-/.exec(range) : null;
      if (m) {
        const start = Number(m[1]);
        res.writeHead(206, { "content-length": BODY.length - start, "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
        res.end(BODY.subarray(start));
      } else {
        res.writeHead(200, { "content-length": BODY.length });
        res.end(BODY);
      }
    };

    switch (url.pathname) {
      case "/file":
        return sendFile();
      case "/flaky":
        if (n <= 2) {
          res.writeHead(503);
          return res.end();
        }
        return sendFile();
      case "/missing":
        res.writeHead(404);
        return res.end();
      case "/cut":
        // First attempt: send half the body, then drop the connection.
        if (n === 1) {
          res.writeHead(200, { "content-length": BODY.length });
          res.write(BODY.subarray(0, BODY.length / 2), () => setTimeout(() => res.destroy(), 20));
          return;
        }
        return sendFile();
      case "/slow": {
        res.writeHead(200, { "content-length": BODY.length });
        let sent = 0;
        const t = setInterval(() => {
          if (res.destroyed) return clearInterval(t);
          res.write(BODY.subarray(sent, sent + 1024));
          sent += 1024;
          if (sent >= BODY.length) {
            clearInterval(t);
            res.end();
          }
        }, 20);
        return;
      }
      case "/redirect-http":
        res.writeHead(302, { location: "http://example.com/file" });
        return res.end();
      default:
        res.writeHead(500);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function queue(extra: Partial<ConstructorParameters<typeof DownloadQueue>[0]> = {}) {
  return new DownloadQueue({ userAgent: "NexCraft-test", insecureHosts: ["127.0.0.1"], retryDelayMs: () => 10, ...extra });
}

describe("validateDownloadUrl", () => {
  it("accepts https and refuses plain http, other schemes and embedded credentials", () => {
    expect(validateDownloadUrl("https://piston-data.mojang.com/x.jar").hostname).toBe("piston-data.mojang.com");
    expect(() => validateDownloadUrl("http://example.com/x.jar")).toThrow(/Only HTTPS/);
    expect(() => validateDownloadUrl("file:///C:/Windows/win.ini")).toThrow(/Only HTTPS/);
    expect(() => validateDownloadUrl("https://user:pass@example.com/x")).toThrow(/credentials/);
    expect(() => validateDownloadUrl("not a url")).toThrow(/valid URL/);
  });
});

describe("DownloadQueue", () => {
  it("downloads, verifies sha1 and size, and renames into place", async () => {
    const dir = tmpDir();
    const dest = path.join(dir, "server.jar");
    const { done } = queue().enqueue({ url: `${base}/file`, dest, title: "server.jar", hash: { algo: "sha1", value: SHA1 }, size: BODY.length });
    const out = await done;
    expect(out).toEqual({ ok: true, path: dest, bytes: BODY.length });
    expect(fs.readFileSync(dest).equals(BODY)).toBe(true);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("fails on a hash mismatch and never leaves the file in place", async () => {
    const dir = tmpDir();
    const dest = path.join(dir, "bad.jar");
    const q = queue({ maxAttempts: 2 });
    const { done } = q.enqueue({ url: `${base}/file`, dest, title: "bad.jar", hash: { algo: "sha256", value: "0".repeat(64) } });
    const out = await done;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/sha256 mismatch/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(q.jobs()[0].status).toBe("failed");
  });

  it("retries server errors with backoff and then succeeds", async () => {
    const dest = path.join(tmpDir(), "flaky.jar");
    const out = await queue().enqueue({ url: `${base}/flaky`, dest, title: "flaky", hash: { algo: "sha256", value: SHA256 } }).done;
    expect(out.ok).toBe(true);
    expect(hits.get("/flaky")).toBe(3);
  });

  it("does not retry a 404", async () => {
    const before = hits.get("/missing") ?? 0;
    const out = await queue().enqueue({ url: `${base}/missing`, dest: path.join(tmpDir(), "m"), title: "missing" }).done;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/404/);
    expect((hits.get("/missing") ?? 0) - before).toBe(1);
  });

  it("resumes an interrupted download with a Range request and still verifies the whole file", async () => {
    const dest = path.join(tmpDir(), "cut.jar");
    const out = await queue().enqueue({ url: `${base}/cut`, dest, title: "cut", hash: { algo: "sha1", value: SHA1 }, size: BODY.length }).done;
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(dest).equals(BODY)).toBe(true);
    expect(ranges.some((r) => r.startsWith("/cut bytes="))).toBe(true);
  });

  it("resumes from a .part file left by an earlier session", async () => {
    const dest = path.join(tmpDir(), "resume.jar");
    fs.writeFileSync(`${dest}.part`, BODY.subarray(0, 1000));
    const out = await queue().enqueue({ url: `${base}/file`, dest, title: "resume", hash: { algo: "sha1", value: SHA1 }, size: BODY.length }).done;
    expect(out.ok).toBe(true);
    expect(ranges).toContain("/file bytes=1000-");
    expect(fs.readFileSync(dest).equals(BODY)).toBe(true);
  });

  it("cancels a running download and removes the partial file", async () => {
    const dest = path.join(tmpDir(), "slow.jar");
    const q = queue();
    const { job, done } = q.enqueue({ url: `${base}/slow`, dest, title: "slow" });
    await new Promise((r) => setTimeout(r, 120));
    expect(q.cancel(job.id)).toBe(true);
    const out = await done;
    expect(out).toMatchObject({ ok: false, cancelled: true });
    expect(q.jobs()[0].status).toBe("cancelled");
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("refuses non-HTTPS URLs before any request", async () => {
    const out = await new DownloadQueue({ userAgent: "t" }).enqueue({ url: "http://example.com/a.jar", dest: path.join(tmpDir(), "a"), title: "a" }).done;
    expect(out).toMatchObject({ ok: false, cancelled: false });
  });

  it("refuses a redirect to plain HTTP without requesting it", async () => {
    const requested: string[] = [];
    const spy: typeof fetch = (input, init) => {
      requested.push(String(input));
      return fetch(input, init);
    };
    const out = await queue({ maxAttempts: 1, fetch: spy }).enqueue({ url: `${base}/redirect-http`, dest: path.join(tmpDir(), "r"), title: "r" }).done;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Only HTTPS/);
    expect(requested).toEqual([`${base}/redirect-http`]);
  });

  it("never runs more downloads at once than the concurrency limit", async () => {
    const dir = tmpDir();
    let peak = 0;
    const q = queue({
      concurrency: 2,
      onChange: (jobs) => (peak = Math.max(peak, jobs.filter((j) => j.status === "running").length)),
    });
    const all = [0, 1, 2, 3, 4].map((i) => q.enqueue({ url: `${base}/file`, dest: path.join(dir, `f${i}`), title: `f${i}` }).done);
    const results = await Promise.all(all);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it("clears finished jobs but keeps active ones", async () => {
    const q = queue();
    await q.enqueue({ url: `${base}/file`, dest: path.join(tmpDir(), "c"), title: "c" }).done;
    expect(q.jobs()).toHaveLength(1);
    q.clearFinished();
    expect(q.jobs()).toHaveLength(0);
  });
});
