import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { silentLog, tmpDir } from "../../../test/helpers/tmp";
import { buildZip } from "../../../test/helpers/zip";
import type { ServerInstance } from "../../shared/model";
import type { ServerState } from "../../shared/servers";
import { DownloadQueue } from "../core/download-queue";
import type { ModrinthVersion } from "../providers/modrinth";
import { ModService } from "./mod-service";

const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");
const fabricJar = (id: string, extra: Record<string, unknown> = {}) => buildZip([{ name: "fabric.mod.json", data: JSON.stringify({ id, name: id, version: "1.0.0", ...extra }) }]);

const LITHIUM = fabricJar("lithium");
const LITHIUM_NEW = fabricJar("lithium", { version: "1.1.0" });
const API = fabricJar("fabric-api", { name: "Fabric API" });
const NEEDS_API = fabricJar("needs-api", { depends: { "fabric-api": "*" } });

function mrVersion(id: string, project: string, body: Buffer, patch: Partial<ModrinthVersion> = {}): ModrinthVersion {
  return {
    id,
    project_id: project,
    name: id,
    version_number: id,
    version_type: "release",
    game_versions: ["1.21.1"],
    loaders: ["fabric"],
    date_published: "2026-01-01",
    files: [{ url: `https://cdn.modrinth.com/data/${project}/${id}.jar`, filename: `${project}-${id}.jar`, primary: true, size: body.length, hashes: { sha1: sha1(body) } }],
    dependencies: [],
    ...patch,
  };
}

function setup(opts: { versions?: ModrinthVersion[]; bodies?: Record<string, Buffer>; projects?: Record<string, { server_side?: string }>; offline?: boolean; type?: string } = {}) {
  const root = tmpDir();
  const dir = path.join(root, "server");
  fs.mkdirSync(path.join(dir, "mods"), { recursive: true });
  const server = { id: "s1", name: "Test", directory: dir, minecraftVersion: "1.21.1", type: opts.type ?? "fabric", loaderVersion: "0.16.10" } as unknown as ServerInstance;
  let state: ServerState = "stopped";
  const versions = opts.versions ?? [];
  const bodies = opts.bodies ?? {};
  const downloads = new DownloadQueue({
    userAgent: "t",
    retryDelayMs: () => 1,
    maxAttempts: 1,
    fetch: (async (url: string) => {
      const v = versions.find((x) => x.files[0].url === String(url));
      const body = v ? bodies[v.id] : undefined;
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("nope", { status: 404 });
    }) as unknown as typeof fetch,
  });
  const offline = () => {
    if (opts.offline) throw new TypeError("fetch failed");
  };
  const svc = new ModService({
    state: { server: (id) => (id === server.id ? server : null) },
    servers: { status: () => ({ state }) as never },
    downloads,
    modrinth: {
      versionsByHash: async (hashes: string[]) => {
        offline();
        return Object.fromEntries(versions.filter((v) => hashes.includes(v.files[0].hashes.sha1!)).map((v) => [v.files[0].hashes.sha1!, v]));
      },
      updatesByHash: async (hashes: string[]) => {
        const out: Record<string, ModrinthVersion> = {};
        for (const h of hashes) {
          const current = versions.find((v) => v.files[0].hashes.sha1 === h);
          const newest = versions.filter((v) => v.project_id === current?.project_id).at(-1);
          if (newest) out[h] = newest;
        }
        return out;
      },
      projects: async () => [],
      project: async (id: string) => ({ id, slug: id, title: id, server_side: opts.projects?.[id]?.server_side ?? "required" }),
      versions: async (project: string) => versions.filter((v) => v.project_id === project).reverse(),
      version: async (id: string) => versions.find((v) => v.id === id)!,
    } as never,
    curseforge: { available: () => false } as never,
    log: silentLog,
  });
  const put = (name: string, body: Buffer) => fs.writeFileSync(path.join(dir, "mods", name), body);
  const files = () => fs.readdirSync(path.join(dir, "mods")).sort();
  return { svc, server, dir, put, files, setState: (s: ServerState) => (state = s) };
}

describe("ModService.list", () => {
  it("labels mods by what the provider and the jar say", async () => {
    const lith = mrVersion("l1", "lithium", LITHIUM);
    const { svc, put } = setup({ versions: [lith] });
    put("lithium.jar", LITHIUM);
    put("needs.jar", NEEDS_API);
    put("library.jar", buildZip([{ name: "a.class", data: "x" }]));
    put("off.jar.disabled", API);
    const { mods, providerChecked } = await svc.list("s1");
    expect(providerChecked).toBe(true);
    const by = Object.fromEntries(mods.map((m) => [m.file, m]));
    expect(by["lithium.jar"]).toMatchObject({ label: "confirmed", source: { provider: "modrinth", projectId: "lithium", versionId: "l1" } });
    expect(by["needs.jar"]).toMatchObject({ label: "conflict", reasons: ["Needs Fabric API, which is switched off."] });
    expect(by["library.jar"].label).toBe("unknown");
    expect(by["off.jar.disabled"].enabled).toBe(false);
  });

  it("still works offline, relying on metadata", async () => {
    const { svc, put } = setup({ offline: true });
    put("lithium.jar", LITHIUM);
    const res = await svc.list("s1");
    expect(res.providerChecked).toBe(false);
    expect(res.mods[0].label).toBe("metadata");
  });

  it("refuses Vanilla servers", async () => {
    await expect(setup({ type: "vanilla" }).svc.list("s1")).rejects.toThrow(/Vanilla servers cannot run mods/);
  });
});

describe("adding from Modrinth", () => {
  it("brings required dependencies, skips installed ones, and can be undone", async () => {
    const api = mrVersion("a1", "fabric-api", API);
    const needs = mrVersion("n1", "needs", NEEDS_API, { dependencies: [{ project_id: "fabric-api", version_id: null, file_name: null, dependency_type: "required" }] });
    const { svc, files } = setup({ versions: [api, needs], bodies: { a1: API, n1: NEEDS_API } });

    const plan = await svc.planAdd("s1", "modrinth", "needs", null);
    expect(plan.files.map((f) => [f.name, f.reason])).toEqual([
      ["needs", "requested"],
      ["fabric-api", "dependency"],
    ]);
    await svc.apply(plan.id);
    expect(files()).toEqual(["fabric-api-a1.jar", "needs-n1.jar"]);
    expect((await svc.list("s1")).mods.every((m) => m.label === "confirmed")).toBe(true);

    const [entry] = svc.history("s1");
    expect(entry).toMatchObject({ summary: "Added needs, fabric-api", canUndo: true });
    svc.undo("s1", entry.id);
    expect(files()).toEqual([]);
    expect(svc.history("s1")[0]).toMatchObject({ undone: true, canUndo: false });
  });

  it("does not re-add a dependency that is already installed", async () => {
    const api = mrVersion("a1", "fabric-api", API);
    const needs = mrVersion("n1", "needs", NEEDS_API, { dependencies: [{ project_id: "fabric-api", version_id: null, file_name: null, dependency_type: "required" }] });
    const { svc, put } = setup({ versions: [api, needs], bodies: { a1: API, n1: NEEDS_API } });
    put("fabric-api.jar", API);
    const plan = await svc.planAdd("s1", "modrinth", "needs", null);
    expect(plan.files.map((f) => f.name)).toEqual(["needs"]);
  });

  it("refuses client-only mods and mods with no version for the server", async () => {
    const { svc } = setup({ versions: [mrVersion("x1", "other", API, { game_versions: ["1.20.1"] })], projects: { sodium: { server_side: "unsupported" } } });
    await expect(svc.planAdd("s1", "modrinth", "sodium", null)).rejects.toThrow(/only runs in the game client/);
    await expect(svc.planAdd("s1", "modrinth", "empty", null)).rejects.toThrow(/no version for Minecraft 1.21.1 on Fabric/);
  });

  it("leaves the mods folder alone when a download fails", async () => {
    const { svc, files, dir } = setup({ versions: [mrVersion("l1", "lithium", LITHIUM)], bodies: {} });
    const plan = await svc.planAdd("s1", "modrinth", "lithium", null);
    await expect(svc.apply(plan.id)).rejects.toThrow();
    expect(files()).toEqual([]);
    expect(fs.readdirSync(path.join(dir, ".nexcraft", "mod-history"))).toEqual([]);
  });
});

describe("changing installed mods", () => {
  it("switches mods off and on, removes them, and undoes each step", async () => {
    const { svc, put, files } = setup();
    put("lithium.jar", LITHIUM);
    svc.setEnabled("s1", ["lithium.jar"], false);
    expect(files()).toEqual(["lithium.jar.disabled"]);
    svc.remove("s1", ["lithium.jar.disabled"]);
    expect(files()).toEqual([]);

    const [removal, disabling] = svc.history("s1");
    expect(removal.summary).toBe("Removed lithium");
    svc.undo("s1", removal.id);
    expect(files()).toEqual(["lithium.jar.disabled"]);
    svc.undo("s1", disabling.id);
    expect(files()).toEqual(["lithium.jar"]);
  });

  it("will not undo over a file that has changed since", async () => {
    const { svc, put } = setup();
    put("lithium.jar", LITHIUM);
    svc.remove("s1", ["lithium.jar"]);
    put("lithium.jar", LITHIUM_NEW);
    const [entry] = svc.history("s1");
    expect(entry.canUndo).toBe(false);
    expect(() => svc.undo("s1", entry.id)).toThrow(/back in the mods folder/);
  });

  it("refuses changes while the server runs, and odd file names", async () => {
    const { svc, put, setState } = setup();
    put("lithium.jar", LITHIUM);
    expect(() => svc.remove("s1", ["../server.properties"])).toThrow(/not a mod file/);
    setState("running");
    expect(() => svc.remove("s1", ["lithium.jar"])).toThrow(/Stop Test before changing its mods/);
  });

  it("updates through Modrinth, keeping a switched-off mod switched off", async () => {
    const old = mrVersion("l1", "lithium", LITHIUM);
    const next = mrVersion("l2", "lithium", LITHIUM_NEW);
    const { svc, put, files } = setup({ versions: [old, next], bodies: { l2: LITHIUM_NEW } });
    put("lithium-l1.jar.disabled", LITHIUM);
    const updates = await svc.checkUpdates("s1");
    expect(updates).toEqual([expect.objectContaining({ file: "lithium-l1.jar.disabled", newVersion: "l2" })]);
    const plan = await svc.planUpdate("s1", updates);
    expect(plan.files[0]).toMatchObject({ reason: "update", replaces: "lithium-l1.jar.disabled" });
    await svc.apply(plan.id);
    expect(files()).toEqual(["lithium-l2.jar.disabled"]);
    svc.undo("s1", svc.history("s1")[0].id);
    expect(files()).toEqual(["lithium-l1.jar.disabled"]);
  });

  it("adds jar files the user picks and rejects anything else", async () => {
    const { svc, files } = setup();
    const src = tmpDir();
    fs.writeFileSync(path.join(src, "lithium.jar"), LITHIUM);
    fs.writeFileSync(path.join(src, "notes.txt"), "hi");
    fs.writeFileSync(path.join(src, "broken.jar"), "not a zip");
    const res = await svc.addFiles("s1", ["lithium.jar", "notes.txt", "broken.jar"].map((f) => path.join(src, f)));
    expect(res).toEqual({ added: ["lithium"], rejected: ["notes.txt", "broken.jar"] });
    expect(files()).toEqual(["lithium.jar"]);
  });
});
