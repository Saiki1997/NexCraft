import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../../../test/helpers/tmp";
import { MANIFEST_URL, MojangClient } from "./mojang";

const v121 = JSON.stringify({
  id: "1.21.4",
  javaVersion: { component: "java-runtime-delta", majorVersion: 21 },
  downloads: { server: { sha1: "a".repeat(40), size: 57_000_000, url: "https://piston-data.mojang.com/v1/objects/aaa/server.jar" } },
});
const v100 = JSON.stringify({ id: "1.0", downloads: { client: { sha1: "b".repeat(40), size: 1, url: "https://x/c.jar" } } });
const v1122 = JSON.stringify({ id: "1.12.2", downloads: { server: { sha1: "c".repeat(40), size: 10, url: "https://x/s.jar" } } });
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

const manifest = {
  latest: { release: "1.21.4", snapshot: "25w01a" },
  versions: [
    { id: "25w01a", type: "snapshot", url: "https://piston-meta.mojang.com/s.json", time: "", releaseTime: "2025-01-02T00:00:00+00:00", sha1: "d".repeat(40), complianceLevel: 1 },
    { id: "1.21.4", type: "release", url: "https://piston-meta.mojang.com/1.21.4.json", time: "", releaseTime: "2024-12-03T00:00:00+00:00", sha1: sha(v121), complianceLevel: 1 },
    { id: "1.12.2", type: "release", url: "https://piston-meta.mojang.com/1.12.2.json", time: "", releaseTime: "2017-09-18T00:00:00+00:00", sha1: sha(v1122), complianceLevel: 0 },
    { id: "1.0", type: "release", url: "https://piston-meta.mojang.com/1.0.json", time: "", releaseTime: "2011-11-17T00:00:00+00:00", sha1: sha(v100), complianceLevel: 0 },
  ],
};

function fakeFetch(online = true): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const bodies: Record<string, string> = {
    [MANIFEST_URL]: JSON.stringify(manifest),
    "https://piston-meta.mojang.com/1.21.4.json": v121,
    "https://piston-meta.mojang.com/1.12.2.json": v1122,
    "https://piston-meta.mojang.com/1.0.json": v100,
  };
  const f = (async (url: string | URL) => {
    calls.push(String(url));
    if (!online) throw new TypeError("fetch failed");
    const body = bodies[String(url)];
    return new Response(body ?? "not found", { status: body ? 200 : 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("MojangClient", () => {
  it("lists releases and hides snapshots by default", async () => {
    const { fetch } = fakeFetch();
    const r = await new MojangClient(tmpDir(), "test", fetch).versions();
    expect(r.latest).toBe("1.21.4");
    expect(r.versions.map((v) => v.id)).toEqual(["1.21.4", "1.12.2", "1.0"]);
  });

  it("returns the server download with Mojang's Java requirement", async () => {
    const { fetch } = fakeFetch();
    const d = await new MojangClient(tmpDir(), "test", fetch).serverDownload("1.21.4");
    expect(d).toMatchObject({ versionId: "1.21.4", sha1: "a".repeat(40), size: 57_000_000, javaMajor: 21, javaFromManifest: true });
  });

  it("falls back to the Java table when the version JSON has no requirement", async () => {
    const { fetch } = fakeFetch();
    const d = await new MojangClient(tmpDir(), "test", fetch).serverDownload("1.12.2");
    expect(d).toMatchObject({ javaMajor: 8, javaFromManifest: false });
  });

  it("explains versions with no dedicated server and unknown versions", async () => {
    const { fetch } = fakeFetch();
    const client = new MojangClient(tmpDir(), "test", fetch);
    await expect(client.serverDownload("1.0")).rejects.toThrow(/does not publish a dedicated server/);
    await expect(client.serverDownload("9.9")).rejects.toThrow(/not in Mojang's version list/);
  });

  it("works offline from the cache it saved earlier", async () => {
    const cache = tmpDir();
    await new MojangClient(cache, "test", fakeFetch().fetch).serverDownload("1.21.4");
    // Make the manifest cache stale so a request is attempted, then fail it.
    const manifestCache = path.join(cache, "mojang", "version_manifest_v2.json");
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(manifestCache, old, old);
    const offline = fakeFetch(false);
    const client = new MojangClient(cache, "test", offline.fetch);
    const r = await client.versions();
    expect(r.fromCache).toBe(true);
    expect((await client.serverDownload("1.21.4")).javaMajor).toBe(21);
  });

  it("rejects a version JSON whose SHA-1 does not match the manifest", async () => {
    const bad = (async (url: string | URL) =>
      new Response(String(url) === MANIFEST_URL ? JSON.stringify(manifest) : v121.replace("57000000", "1"), { status: 200 })) as typeof fetch;
    await expect(new MojangClient(tmpDir(), "test", bad).serverDownload("1.21.4")).rejects.toThrow(/Checksum mismatch/);
  });
});
