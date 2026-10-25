import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../../../test/helpers/tmp";
import { compareVersions, forgeLaunchArgs, Loaders, neoforgeVersionsFor, parseMavenVersions, type InstallContext } from "./loaders";

const SHA = "a".repeat(40);

function fakeFetch(routes: Record<string, string | number>) {
  const seen: string[] = [];
  const fn = (async (url: string) => {
    seen.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return new Response("missing", { status: 404 });
    if (typeof body === "number") return new Response("", { status: body });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const maven = (...versions: string[]) => `<metadata><versioning><versions>${versions.map((v) => `<version>${v}</version>`).join("")}</versions></versioning></metadata>`;

function ctx(dir: string, over: Partial<InstallContext> = {}) {
  const downloaded: { url: string; dest: string; hash?: unknown }[] = [];
  const ran: string[][] = [];
  const messages: string[] = [];
  const c: InstallContext = {
    dir,
    minecraftVersion: "1.21.1",
    loaderVersion: "0.16.9",
    platform: "win32",
    report: (m) => messages.push(m),
    downloads: {
      enqueue: (req) => {
        downloaded.push({ url: req.url, dest: req.dest, hash: req.hash });
        fs.writeFileSync(req.dest, "jar");
        return { job: {} as never, done: Promise.resolve({ ok: true as const, path: req.dest, bytes: 3 }) };
      },
    },
    runJava: async (args, { cwd, onLine }) => {
      ran.push(args);
      onLine("installer says hi");
      if (args.includes("--installServer") || args.includes("--install-server")) {
        const group = args.includes("--installServer") ? "net/minecraftforge/forge/1.21.1-52.0.1" : "net/neoforged/neoforge/21.1.77";
        fs.mkdirSync(path.join(cwd, "libraries", group), { recursive: true });
        fs.writeFileSync(path.join(cwd, "libraries", group, "win_args.txt"), "");
      }
      if (args.includes("install")) fs.writeFileSync(path.join(cwd, "quilt-server-launch.jar"), "");
      return 0;
    },
    ...over,
  };
  return { c, downloaded, ran, messages };
}

describe("loader version lists", () => {
  it("reads Fabric and Quilt versions and prefers a stable one", async () => {
    const { fn } = fakeFetch({
      "https://meta.fabricmc.net/v2/versions/loader/1.21.1": JSON.stringify([
        { loader: { version: "0.17.0-beta.1", stable: false } },
        { loader: { version: "0.16.9", stable: true } },
      ]),
      "https://meta.quiltmc.org/v3/versions/loader/1.21.1": JSON.stringify([
        { loader: { version: "0.24.0" } },
        { loader: { version: "0.27.0-beta.1" } },
        { loader: { version: "0.26.4" } },
        { loader: { version: "0.9.2" } },
      ]),
      "https://meta.fabricmc.net/v2/versions/loader/0.1": 400,
    });
    const l = new Loaders({ userAgent: "t", fetch: fn, cacheDir: tmpDir() });
    expect(await l.versions("fabric", "1.21.1")).toMatchObject({ recommended: "0.16.9", versions: [{ stable: false }, { stable: true }] });
    const quilt = await l.versions("quilt", "1.21.1");
    expect(quilt.recommended).toBe("0.26.4");
    expect(quilt.versions.map((v) => v.version)).toEqual(["0.27.0-beta.1", "0.26.4", "0.24.0", "0.9.2"]);
    expect(await l.versions("fabric", "0.1")).toEqual({ versions: [], recommended: null });
  });

  it("filters Forge builds by Minecraft version and uses the recommended promotion", async () => {
    const { fn } = fakeFetch({
      "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml": maven("1.21.1-52.0.10", "1.21.1-52.0.2", "1.21.10-60.0.1", "1.20.1-47.3.0"),
      "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json": JSON.stringify({ promos: { "1.21.1-recommended": "52.0.2" } }),
    });
    const l = new Loaders({ userAgent: "t", fetch: fn, cacheDir: tmpDir() });
    const r = await l.versions("forge", "1.21.1");
    expect(r.versions.map((v) => v.version)).toEqual(["52.0.10", "52.0.2"]);
    expect(r.recommended).toBe("52.0.2");
  });

  it("maps NeoForge versions to Minecraft versions", () => {
    const all = ["20.2.86", "20.4.237", "21.0.167", "21.1.77", "21.1.80-beta", "21.10.5", "26.1.0.3-beta", "26.1.0.7", "26.1.1.2", "26.10.0.1"];
    expect(neoforgeVersionsFor(all, "1.21.1")).toEqual(["21.1.77", "21.1.80-beta"]);
    expect(neoforgeVersionsFor(all, "1.21")).toEqual(["21.0.167"]);
    expect(neoforgeVersionsFor(all, "1.20.1")).toEqual([]);
    expect(neoforgeVersionsFor(all, "1.19.2")).toEqual([]);
    expect(neoforgeVersionsFor(all, "26.1")).toEqual(["26.1.0.3-beta", "26.1.0.7"]);
    expect(neoforgeVersionsFor(all, "26.1.1")).toEqual(["26.1.1.2"]);
    expect(neoforgeVersionsFor(all, "26.10")).toEqual(["26.10.0.1"]);
  });

  it("compares versions numerically", () => {
    expect(["52.0.10", "52.0.9", "52.0.2"].sort(compareVersions)).toEqual(["52.0.2", "52.0.9", "52.0.10"]);
    expect(parseMavenVersions(maven("1", "2"))).toEqual(["1", "2"]);
  });
});

describe("loader installs", () => {
  it("installs Fabric from its server launcher without running anything", async () => {
    const { fn } = fakeFetch({ "https://meta.fabricmc.net/v2/versions/installer": JSON.stringify([{ version: "1.0.1", stable: true }]) });
    const dir = tmpDir();
    const { c, downloaded, ran } = ctx(dir);
    const r = await new Loaders({ userAgent: "t", fetch: fn, cacheDir: tmpDir() }).install("fabric", c);
    expect(downloaded[0].url).toBe("https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.9/1.0.1/server/jar");
    expect(ran).toEqual([]);
    expect(r.launchArgs).toEqual(["-jar", "fabric-server-launch.jar", "nogui"]);
    expect(fs.readFileSync(path.join(dir, "fabric-server-launcher.properties"), "utf8")).toContain("serverJar=server.jar");
  });

  it("runs the checksum-verified Forge installer and starts from the argument file", async () => {
    const base = "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.1/forge-1.21.1-52.0.1-installer.jar";
    const { fn } = fakeFetch({ [`${base}.sha1`]: SHA });
    const dir = tmpDir();
    const { c, downloaded, ran, messages } = ctx(dir, { loaderVersion: "52.0.1" });
    const r = await new Loaders({ userAgent: "t", fetch: fn, cacheDir: tmpDir() }).install("forge", c);
    expect(downloaded[0]).toMatchObject({ url: base, hash: { algo: "sha1", value: SHA } });
    expect(ran[0]).toEqual(["-jar", "forge-1.21.1-52.0.1-installer.jar", "--installServer", "."]);
    expect(r.launchArgs).toEqual(["@libraries/net/minecraftforge/forge/1.21.1-52.0.1/win_args.txt", "nogui"]);
    expect(fs.existsSync(path.join(dir, "forge-1.21.1-52.0.1-installer.jar"))).toBe(false);
    expect(messages).toContain("installer says hi");
  });

  it("installs NeoForge and reports a failed installer", async () => {
    const { fn } = fakeFetch({});
    const dir = tmpDir();
    const { c } = ctx(dir, { loaderVersion: "21.1.77" });
    const r = await new Loaders({ userAgent: "t", fetch: fn, cacheDir: tmpDir() }).install("neoforge", c);
    expect(r.launchArgs).toEqual(["@libraries/net/neoforged/neoforge/21.1.77/win_args.txt", "nogui"]);

    const failing = ctx(tmpDir(), { loaderVersion: "21.1.77", runJava: async () => 1 });
    await expect(new Loaders({ userAgent: "t", fetch: fn, cacheDir: tmpDir() }).install("neoforge", failing.c)).rejects.toThrow(/exit code 1/);
  });

  it("installs Quilt with the newest stable installer", async () => {
    const { fn } = fakeFetch({ "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml": maven("0.9.2", "0.10.0-beta.1", "0.9.10") });
    const dir = tmpDir();
    const { c, ran, downloaded } = ctx(dir, { loaderVersion: "0.26.4" });
    const r = await new Loaders({ userAgent: "t", fetch: fn, cacheDir: tmpDir() }).install("quilt", c);
    expect(downloaded[0].url).toContain("/0.9.10/quilt-installer-0.9.10.jar");
    expect(ran[0]).toEqual(["-jar", "quilt-installer-0.9.10.jar", "install", "server", "1.21.1", "0.26.4", "--install-dir=."]);
    expect(r.launchArgs).toEqual(["-jar", "quilt-server-launch.jar", "nogui"]);
  });

  it("finds the runnable jar of an old Forge install", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "forge-1.12.2-14.23.5.2860.jar"), "");
    fs.writeFileSync(path.join(dir, "minecraft_server.1.12.2.jar"), "");
    expect(forgeLaunchArgs(dir, "forge", "1.12.2-14.23.5.2860", "win32")).toEqual(["-jar", "forge-1.12.2-14.23.5.2860.jar", "nogui"]);
    expect(forgeLaunchArgs(tmpDir(), "forge", "x", "linux")).toBeNull();
  });
});
