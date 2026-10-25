/**
 * Mod loader servers: Fabric, Quilt, Forge and NeoForge. Each loader is looked up
 * through its official metadata service and installed with its official files.
 * Installers that are Java programs (Quilt, Forge, NeoForge) are downloaded from
 * the loader's own Maven repository, checked against the published SHA-1, and
 * run with the server's Java inside the server folder.
 */
import fs from "node:fs";
import path from "node:path";
import type { DownloadQueue } from "../core/download-queue";
import { fetchJson, fetchText, type JsonFetchOptions } from "../core/http-json";

export type LoaderType = "fabric" | "quilt" | "forge" | "neoforge";

export interface LoaderVersion {
  version: string;
  stable: boolean;
}

export interface LoaderVersionList {
  versions: LoaderVersion[];
  /** The version NexCraft picks when the user does not choose one. */
  recommended: string | null;
}

/** Runs a Java program to completion. Resolves with the exit code. */
export type RunJava = (args: string[], opts: { cwd: string; timeoutMs: number; onLine: (line: string) => void }) => Promise<number>;

export interface InstallContext {
  dir: string;
  minecraftVersion: string;
  loaderVersion: string;
  downloads: Pick<DownloadQueue, "enqueue">;
  runJava: RunJava;
  report: (message: string) => void;
  platform: NodeJS.Platform;
}

export interface InstallResult {
  /** Arguments after the JVM memory options, e.g. ["-jar", "fabric-server-launch.jar", "nogui"]. */
  launchArgs: string[];
}

export interface LoaderOptions {
  userAgent: string;
  fetch?: typeof fetch;
  cacheDir: string;
}

const FABRIC_META = "https://meta.fabricmc.net/v2";
const QUILT_META = "https://meta.quiltmc.org/v3";
const QUILT_MAVEN = "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer";
const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FORGE_PROMOTIONS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";

export const LOADER_NAMES: Record<LoaderType, string> = { fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };

export class Loaders {
  private readonly textCache = new Map<string, { at: number; text: Promise<string> }>();

  constructor(private readonly opts: LoaderOptions) {}

  private json<T>(url: string, cacheName?: string, ttlMs = 30 * 60_000) {
    const o: JsonFetchOptions = { userAgent: this.opts.userAgent, fetch: this.opts.fetch };
    if (cacheName) Object.assign(o, { cacheFile: path.join(this.opts.cacheDir, "loaders", cacheName), cacheTtlMs: ttlMs });
    return fetchJson<T>(url, o).then((r) => r.data);
  }

  /** Maven metadata is large and asked for often while the user browses versions, so keep it briefly. */
  private text(url: string) {
    const hit = this.textCache.get(url);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.text;
    const text = fetchText(url, { userAgent: this.opts.userAgent, fetch: this.opts.fetch, headers: { accept: "*/*" } });
    this.textCache.set(url, { at: Date.now(), text });
    text.catch(() => this.textCache.delete(url));
    return text;
  }

  /** Versions of `type` that support `minecraftVersion`, newest first. */
  async versions(type: LoaderType, minecraftVersion: string): Promise<LoaderVersionList> {
    switch (type) {
      case "fabric":
      case "quilt": {
        const base = type === "fabric" ? FABRIC_META : QUILT_META;
        let list: { loader: { version: string; stable?: boolean } }[];
        try {
          list = await this.json(`${base}/versions/loader/${encodeURIComponent(minecraftVersion)}`);
        } catch (err) {
          if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 404) return { versions: [], recommended: null };
          throw err;
        }
        // Quilt's list is not ordered newest-first, so sort both rather than trusting the order.
        const versions = list
          .map((e) => ({ version: e.loader.version, stable: type === "fabric" ? e.loader.stable !== false : !/beta|alpha|pre|rc/i.test(e.loader.version) }))
          .sort((a, b) => compareVersions(b.version.replace(/[-+].*$/, ""), a.version.replace(/[-+].*$/, "")) || (a.stable === b.stable ? 0 : a.stable ? -1 : 1));
        return { versions, recommended: versions.find((v) => v.stable)?.version ?? versions[0]?.version ?? null };
      }
      case "forge": {
        const all = parseMavenVersions(await this.text(`${FORGE_MAVEN}/maven-metadata.xml`));
        const prefix = `${minecraftVersion}-`;
        const versions = all
          .filter((v) => v.startsWith(prefix))
          .map((v) => v.slice(prefix.length))
          .filter((v) => /^[\d.]+$/.test(v))
          .sort(compareVersions)
          .reverse()
          .map((version) => ({ version, stable: true }));
        let recommended: string | null = null;
        try {
          const promos = await this.json<{ promos: Record<string, string> }>(FORGE_PROMOTIONS, "forge-promotions.json");
          recommended = promos.promos[`${minecraftVersion}-recommended`] ?? promos.promos[`${minecraftVersion}-latest`] ?? null;
        } catch {
          // Promotions are a convenience; fall back to the newest build.
        }
        if (recommended && !versions.some((v) => v.version === recommended)) recommended = null;
        return { versions, recommended: recommended ?? versions[0]?.version ?? null };
      }
      case "neoforge": {
        const all = parseMavenVersions(await this.text(`${NEOFORGE_MAVEN}/maven-metadata.xml`));
        const versions = neoforgeVersionsFor(all, minecraftVersion)
          .sort((a, b) => compareVersions(a.replace(/-.*$/, ""), b.replace(/-.*$/, "")))
          .reverse()
          .map((version) => ({ version, stable: !/-(beta|alpha)/i.test(version) }));
        return { versions, recommended: versions.find((v) => v.stable)?.version ?? versions[0]?.version ?? null };
      }
    }
  }

  async install(type: LoaderType, ctx: InstallContext): Promise<InstallResult> {
    switch (type) {
      case "fabric":
        return this.installFabric(ctx);
      case "quilt":
        return this.installQuilt(ctx);
      case "forge":
        return this.installForgeLike(ctx, "forge");
      case "neoforge":
        return this.installForgeLike(ctx, "neoforge");
    }
  }

  /** Fabric publishes a ready-made server launcher; no installer needs to run. */
  private async installFabric(ctx: InstallContext): Promise<InstallResult> {
    const installers = await this.json<{ version: string; stable: boolean }[]>(`${FABRIC_META}/versions/installer`, "fabric-installers.json");
    const installer = installers.find((i) => i.stable) ?? installers[0];
    if (!installer) throw new Error("Fabric did not list any installer versions");
    const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(ctx.minecraftVersion)}/${encodeURIComponent(ctx.loaderVersion)}/${encodeURIComponent(installer.version)}/server/jar`;
    ctx.report(`Downloading the Fabric ${ctx.loaderVersion} server launcher`);
    await download(ctx, url, path.join(ctx.dir, "fabric-server-launch.jar"), `Fabric ${ctx.loaderVersion} server launcher`);
    // The launcher runs the Vanilla jar NexCraft already downloaded and verified as server.jar.
    fs.writeFileSync(path.join(ctx.dir, "fabric-server-launcher.properties"), "serverJar=server.jar\n");
    return { launchArgs: ["-jar", "fabric-server-launch.jar", "nogui"] };
  }

  private async installQuilt(ctx: InstallContext): Promise<InstallResult> {
    const versions = parseMavenVersions(await this.text(`${QUILT_MAVEN}/maven-metadata.xml`)).filter((v) => !/beta|alpha|pre|rc/i.test(v));
    const latest = versions.sort(compareVersions).at(-1);
    if (!latest) throw new Error("Quilt did not list any installer versions");
    const jarUrl = `${QUILT_MAVEN}/${latest}/quilt-installer-${latest}.jar`;
    const installer = path.join(ctx.dir, `quilt-installer-${latest}.jar`);
    ctx.report(`Downloading the Quilt installer ${latest}`);
    await download(ctx, jarUrl, installer, `Quilt installer ${latest}`, await this.sha1(jarUrl));
    try {
      ctx.report(`Installing Quilt ${ctx.loaderVersion}`);
      const code = await ctx.runJava(["-jar", path.basename(installer), "install", "server", ctx.minecraftVersion, ctx.loaderVersion, `--install-dir=.`], {
        cwd: ctx.dir,
        timeoutMs: 10 * 60_000,
        onLine: ctx.report,
      });
      if (code !== 0) throw new Error(`The Quilt installer failed (exit code ${code}). Its output is in the install log.`);
    } finally {
      fs.rmSync(installer, { force: true });
    }
    if (!fs.existsSync(path.join(ctx.dir, "quilt-server-launch.jar"))) throw new Error("The Quilt installer finished but did not create quilt-server-launch.jar");
    fs.writeFileSync(path.join(ctx.dir, "quilt-server-launcher.properties"), "serverJar=server.jar\n");
    return { launchArgs: ["-jar", "quilt-server-launch.jar", "nogui"] };
  }

  private async installForgeLike(ctx: InstallContext, kind: "forge" | "neoforge"): Promise<InstallResult> {
    const name = kind === "forge" ? "Forge" : "NeoForge";
    const full = kind === "forge" ? `${ctx.minecraftVersion}-${ctx.loaderVersion}` : ctx.loaderVersion;
    const base = kind === "forge" ? FORGE_MAVEN : NEOFORGE_MAVEN;
    const jarName = `${kind}-${full}-installer.jar`;
    const jarUrl = `${base}/${full}/${jarName}`;
    const installer = path.join(ctx.dir, jarName);
    ctx.report(`Downloading the ${name} ${ctx.loaderVersion} installer`);
    await download(ctx, jarUrl, installer, `${name} ${ctx.loaderVersion} installer`, await this.sha1(jarUrl));
    try {
      ctx.report(`Installing ${name} ${ctx.loaderVersion}. This downloads the game libraries and can take a few minutes.`);
      const code = await ctx.runJava(["-jar", jarName, kind === "forge" ? "--installServer" : "--install-server", "."], {
        cwd: ctx.dir,
        timeoutMs: 20 * 60_000,
        onLine: ctx.report,
      });
      if (code !== 0) throw new Error(`The ${name} installer failed (exit code ${code}). Its output is in the install log.`);
    } finally {
      fs.rmSync(installer, { force: true });
    }
    const launch = forgeLaunchArgs(ctx.dir, kind, full, ctx.platform);
    if (!launch) throw new Error(`The ${name} installer finished but NexCraft could not find how to start the server`);
    return { launchArgs: launch };
  }

  private async sha1(url: string): Promise<string | undefined> {
    try {
      const text = (await this.text(`${url}.sha1`)).trim().split(/\s+/)[0];
      return /^[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  }
}

async function download(ctx: InstallContext, url: string, dest: string, title: string, sha1?: string) {
  const { done } = ctx.downloads.enqueue({ url, dest, title, hash: sha1 ? { algo: "sha1", value: sha1 } : undefined });
  const result = await done;
  if (!result.ok) throw new Error(result.cancelled ? `${title}: download cancelled` : `${title}: ${result.error}`);
}

/**
 * Work out how to start an installed Forge or NeoForge server. Modern versions
 * (Minecraft 1.17+) use an argument file; older Forge ships a runnable jar.
 */
export function forgeLaunchArgs(dir: string, kind: "forge" | "neoforge", full: string, platform: NodeJS.Platform): string[] | null {
  const group = kind === "forge" ? "net/minecraftforge/forge" : "net/neoforged/neoforge";
  const argsFile = `libraries/${group}/${full}/${platform === "win32" ? "win_args.txt" : "unix_args.txt"}`;
  if (fs.existsSync(path.join(dir, argsFile))) return [`@${argsFile}`, "nogui"];
  const jars = fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f) && f.startsWith(`${kind}-`) && !/installer/i.test(f));
  const jar = jars.find((f) => f.includes("universal")) ?? jars.find((f) => f.includes(full)) ?? jars[0];
  return jar ? ["-jar", jar, "nogui"] : null;
}

export function parseMavenVersions(xml: string): string[] {
  return [...xml.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map((m) => m[1]);
}

/**
 * NeoForge numbers its builds after the Minecraft version: 1.21.1 → 21.1.x,
 * 1.21 → 21.0.x, and from the 2026 year-based releases 26.1 → 26.1.0.x.
 */
export function neoforgeVersionsFor(all: string[], minecraftVersion: string): string[] {
  const parts = minecraftVersion.split(".");
  if (parts[0] === "1") {
    if (parts.length < 2 || Number(parts[1]) < 20 || minecraftVersion === "1.20.1") return [];
    const prefix = `${parts[1]}.${parts[2] ?? "0"}.`;
    return all.filter((v) => v.startsWith(prefix) && v.split(".").length === 3);
  }
  if (!/^\d+(\.\d+)*$/.test(minecraftVersion)) return [];
  const padded = [...parts, "0", "0"].slice(0, 3).join(".");
  const exact = all.filter((v) => v.startsWith(`${padded}.`));
  return exact.length ? exact : all.filter((v) => v.startsWith(`${minecraftVersion}.`) && v.split(".").length === parts.length + 1);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
