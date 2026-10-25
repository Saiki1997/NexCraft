import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { silentLog, tmpDir } from "../../../test/helpers/tmp";
import { buildZip } from "../../../test/helpers/zip";
import type { ServerInstance } from "../../shared/model";
import { DownloadQueue } from "../core/download-queue";
import { ModpackService, parseCfLoader } from "./modpack-service";

const sha1 = (b: Buffer | string) => createHash("sha1").update(b).digest("hex");
const sha512 = (b: Buffer | string) => createHash("sha512").update(b).digest("hex");

const SERVER_MOD = buildZip([{ name: "fabric.mod.json", data: JSON.stringify({ id: "lithium", name: "Lithium", version: "1", environment: "*" }) }]);
const CLIENT_MOD = buildZip([{ name: "fabric.mod.json", data: JSON.stringify({ id: "iris", name: "Iris", version: "1", environment: "client" }) }]);
const SNEAKY_CLIENT_MOD = buildZip([{ name: "fabric.mod.json", data: JSON.stringify({ id: "zoomify", name: "Zoomify", version: "1", environment: "client" }) }]);

function setup(urls: Record<string, Buffer>) {
  const root = tmpDir();
  const fetched: string[] = [];
  const downloads = new DownloadQueue({
    userAgent: "t",
    retryDelayMs: () => 1,
    maxAttempts: 1,
    fetch: (async (url: string) => {
      fetched.push(String(url));
      const body = urls[String(url)];
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("nope", { status: 404 });
    }) as unknown as typeof fetch,
  });
  const servers = new Map<string, ServerInstance>();
  const created: unknown[] = [];
  const svc = new ModpackService({
    servers: {
      create: async (input) => {
        created.push(input);
        const dir = path.join(root, "servers", input.name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "server.properties"), "motd=default\n");
        const s = { id: "s1", name: input.name, directory: dir, minecraftVersion: input.minecraftVersion, type: input.type, modpack: null } as unknown as ServerInstance;
        servers.set(s.id, s);
        return s;
      },
    },
    state: {
      server: (id) => servers.get(id) ?? null,
      upsertServer: (s) => servers.set(s.id, s),
      removeServer: (id) => servers.delete(id),
    },
    downloads,
    modrinth: {} as never,
    curseforge: {
      available: () => true,
      filesById: async (ids: number[]) =>
        ids.map((id) => ({
          id,
          modId: id * 10,
          fileName: `mod-${id}.jar`,
          displayName: `mod ${id}`,
          downloadUrl: id === 3 ? null : `https://edge.forgecdn.net/files/${id}/mod-${id}.jar`,
          fileLength: SERVER_MOD.length,
          hashes: [{ algo: 1, value: id === 2 ? sha1(CLIENT_MOD) : sha1(SERVER_MOD) }],
          gameVersions: id === 2 ? ["1.20.1", "Client"] : ["1.20.1", "Server", "Client"],
        })),
      mods: async (ids: number[]) => ids.map((id) => ({ id, name: `Mod ${id / 10}`, classId: id === 40 ? 12 : 6, links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/m${id}` } })),
    } as never,
    cacheDir: path.join(root, "cache"),
    log: silentLog,
  });
  return { root, svc, fetched, servers, created };
}

function writePack(entries: Parameters<typeof buildZip>[0], ext = ".mrpack") {
  const file = path.join(tmpDir(), `pack${ext}`);
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

const mrIndex = (files: unknown[], deps: Record<string, string> = { minecraft: "1.21.1", "fabric-loader": "0.16.9" }) =>
  JSON.stringify({ formatVersion: 1, game: "minecraft", name: "Test Pack", versionId: "1.0", files, dependencies: deps });

describe("Modrinth packs", () => {
  it("plans, then installs server files, overrides and server-overrides, leaving client mods out", async () => {
    const { svc, fetched, created, servers } = setup({
      "https://cdn.modrinth.com/data/a/lithium.jar": SERVER_MOD,
      "https://cdn.modrinth.com/data/c/zoomify.jar": SNEAKY_CLIENT_MOD,
    });
    const pack = writePack([
      {
        name: "modrinth.index.json",
        data: mrIndex([
          { path: "mods/lithium.jar", hashes: { sha1: sha1(SERVER_MOD), sha512: sha512(SERVER_MOD) }, env: { client: "required", server: "required" }, downloads: ["https://cdn.modrinth.com/data/a/lithium.jar"], fileSize: SERVER_MOD.length },
          { path: "mods/iris.jar", hashes: { sha1: sha1(CLIENT_MOD) }, env: { client: "required", server: "unsupported" }, downloads: ["https://cdn.modrinth.com/data/b/iris.jar"], fileSize: 1 },
          // Mislabelled by the pack, but its own metadata says client-only.
          { path: "mods/zoomify.jar", hashes: { sha1: sha1(SNEAKY_CLIENT_MOD) }, env: { client: "required", server: "optional" }, downloads: ["https://cdn.modrinth.com/data/c/zoomify.jar"], fileSize: SNEAKY_CLIENT_MOD.length },
          { path: "mods/evil.jar", hashes: { sha1: "0".repeat(40) }, downloads: ["https://evil.example.com/evil.jar"], fileSize: 1 },
        ]),
      },
      { name: "overrides/config/lithium.properties", data: "a=1" },
      { name: "overrides/server.properties", data: "motd=from pack\n" },
      { name: "server-overrides/config/lithium.properties", data: "a=server" },
      { name: "client-overrides/options.txt", data: "client stuff" },
    ]);
    const summary = await svc.inspectFile(pack);
    expect(summary).toMatchObject({ name: "Test Pack", minecraftVersion: "1.21.1", loader: { type: "fabric", version: "0.16.9" }, fileCount: 4, serverFileCount: 2, clientOnly: ["iris.jar"] });
    expect(summary.warnings.join(" ")).toMatch(/evil\.jar/);
    expect(fetched).toEqual([]);

    const res = await svc.install(summary.id, { name: "Pack Server", memoryMb: 6144, port: 25570, useServerPack: false }, "k", () => {});
    expect(created[0]).toMatchObject({ type: "fabric", loaderVersion: "0.16.9", minecraftVersion: "1.21.1", memoryMb: 6144 });
    const dir = res.server.directory;
    expect(fs.existsSync(path.join(dir, "mods", "lithium.jar"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "mods", "iris.jar"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "mods", "zoomify.jar"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".nexcraft", "client-only-mods", "zoomify.jar"))).toBe(true);
    expect(res.clientOnlyRemoved).toEqual(["Zoomify"]);
    expect(fs.readFileSync(path.join(dir, "config", "lithium.properties"), "utf8")).toBe("a=server");
    expect(fs.readFileSync(path.join(dir, "server.properties"), "utf8")).toContain("from pack");
    expect(fs.existsSync(path.join(dir, "options.txt"))).toBe(false);
    expect(fetched.some((u) => u.includes("evil"))).toBe(false);
    expect(servers.get("s1")?.modpack).toMatchObject({ source: "local", name: "Test Pack 1.0" });
  });

  it("refuses packs with paths that escape the server folder", async () => {
    const { svc } = setup({});
    const pack = writePack([{ name: "modrinth.index.json", data: mrIndex([{ path: "../../evil.jar", hashes: {}, downloads: [], fileSize: 1 }]) }]);
    await expect(svc.inspectFile(pack)).rejects.toThrow(/not allowed/);
  });

  it("removes the half-made server when a download fails its hash check", async () => {
    const { svc, servers } = setup({ "https://cdn.modrinth.com/data/a/lithium.jar": Buffer.from("tampered") });
    const pack = writePack([
      {
        name: "modrinth.index.json",
        data: mrIndex([{ path: "mods/lithium.jar", hashes: { sha512: sha512(SERVER_MOD) }, env: { server: "required" }, downloads: ["https://cdn.modrinth.com/data/a/lithium.jar"], fileSize: SERVER_MOD.length }]),
      },
    ]);
    const summary = await svc.inspectFile(pack);
    await expect(svc.install(summary.id, { name: "Bad", memoryMb: 4096, port: 25565, useServerPack: false }, "k", () => {})).rejects.toThrow(/could not be downloaded/);
    expect(servers.size).toBe(0);
  });

  it("rejects archives that are not modpacks", async () => {
    const { svc } = setup({});
    await expect(svc.inspectFile(writePack([{ name: "readme.txt", data: "hi" }], ".zip"))).rejects.toThrow(/not a Modrinth/);
  });
});

describe("CurseForge packs", () => {
  const manifest = JSON.stringify({
    manifestType: "minecraftModpack",
    name: "CF Pack",
    version: "2.0",
    overrides: "overrides",
    minecraft: { version: "1.20.1", modLoaders: [{ id: "forge-47.3.0", primary: true }] },
    files: [
      { projectID: 10, fileID: 1, required: true },
      { projectID: 20, fileID: 2, required: true },
      { projectID: 30, fileID: 3, required: true },
      { projectID: 40, fileID: 4, required: true },
      { projectID: 50, fileID: 5, required: false },
    ],
  });

  it("lists client-only and manual downloads, then installs the rest", async () => {
    const { svc, fetched } = setup({ "https://edge.forgecdn.net/files/1/mod-1.jar": SERVER_MOD });
    const pack = writePack([{ name: "manifest.json", data: manifest }, { name: "overrides/config/a.toml", data: "x=1" }], ".zip");
    const summary = await svc.inspectFile(pack);
    expect(summary).toMatchObject({ loader: { type: "forge", version: "47.3.0" }, serverFileCount: 1, clientOnly: ["Mod 2 (mod-2.jar)"] });
    expect(summary.manual).toEqual([{ name: "Mod 3 (mod-3.jar)", path: "mods/mod-3.jar", page: "https://www.curseforge.com/minecraft/mc-mods/m30/files/3", sha1: sha1(SERVER_MOD) }]);

    const res = await svc.install(summary.id, { name: "CF", memoryMb: 8192, port: 25565, useServerPack: false }, "k", () => {});
    expect(fetched).toEqual(["https://edge.forgecdn.net/files/1/mod-1.jar"]);
    expect(fs.readFileSync(path.join(res.server.directory, "config", "a.toml"), "utf8")).toBe("x=1");
    expect(res.manual).toHaveLength(1);
    expect(svc.manualFiles(res.server)).toHaveLength(1);

    // The user downloads it by hand; only the exact file is accepted.
    const wrong = path.join(tmpDir(), "mod-3.jar");
    fs.writeFileSync(wrong, "something else");
    const right = path.join(tmpDir(), "renamed.jar");
    fs.writeFileSync(right, SERVER_MOD);
    expect(svc.addManualFiles(res.server, [wrong, right])).toEqual({ added: ["Mod 3 (mod-3.jar)"], rejected: ["mod-3.jar"] });
    expect(svc.manualFiles(res.server)).toEqual([]);
  });

  it("parses loader ids", () => {
    expect(parseCfLoader("neoforge-21.1.77")).toEqual({ type: "neoforge", version: "21.1.77" });
    expect(parseCfLoader("fabric-0.16.9")).toEqual({ type: "fabric", version: "0.16.9" });
    expect(parseCfLoader("liteloader-1")).toBeNull();
  });
});
