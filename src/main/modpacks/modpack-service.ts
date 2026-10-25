/**
 * Turn a Modrinth (.mrpack) or CurseForge (.zip) modpack into a server.
 *
 * Importing is two steps. `inspect` reads the pack and works out the Minecraft
 * version, loader, server-side files, client-only files and files that must be
 * downloaded by hand, without changing anything. `install` then creates the
 * server, downloads every file with its published hash, applies the pack's
 * overrides, and sets aside mods that only work in the game client.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerInstance } from "../../shared/model";
import type { ImportSummary, ManualFile, ModpackSource } from "../../shared/modpacks";
import { extractZip, listZip, readZipEntry } from "../core/archive";
import type { DownloadQueue } from "../core/download-queue";
import type { ScopedLogger } from "../core/logger";
import { resolveInside, toSafeName } from "../core/safe-path";
import type { LoaderType } from "../loaders/loaders";
import { readModMetadata } from "../mods/mod-metadata";
import { CLASS_MODS, cfFilePage, cfSha1, cfSide, type CfFile, type CurseForgeClient } from "../providers/curseforge";
import { isAllowedMrpackUrl, type ModrinthClient } from "../providers/modrinth";
import type { ServerService } from "../servers/server-service";
import type { StateService } from "../services/state-service";

type Side = "server" | "client" | "both" | "unknown";

interface PackFile {
  path: string;
  name: string;
  size: number;
  sha1?: string;
  sha512?: string;
  url: string | null;
  side: Side;
  manualPage?: string;
}

interface Plan {
  id: string;
  name: string;
  version: string;
  source: ModpackSource;
  projectId: string | null;
  versionId: string | null;
  minecraftVersion: string;
  loader: { type: LoaderType; version: string } | null;
  archive: string;
  overrides: string[];
  files: PackFile[];
  serverPack: { file: CfFile } | null;
  warnings: string[];
}

export interface ModpackServiceDeps {
  servers: Pick<ServerService, "create">;
  state: Pick<StateService, "server" | "upsertServer" | "removeServer">;
  downloads: Pick<DownloadQueue, "enqueue">;
  modrinth: Pick<ModrinthClient, "project" | "versions" | "version">;
  curseforge: Pick<CurseForgeClient, "available" | "mod" | "mods" | "files" | "file" | "filesById">;
  cacheDir: string;
  log: ScopedLogger;
}

export interface InstallOptions {
  name: string;
  memoryMb: number;
  port: number;
  parentDir?: string;
  useServerPack: boolean;
  javaRuntimeId?: string | null;
}

const MANUAL_FILE = path.join(".nexcraft", "manual-downloads.json");
const CLIENT_ONLY_DIR = path.join(".nexcraft", "client-only-mods");

export class ModpackService {
  private readonly plans = new Map<string, Plan>();

  constructor(private readonly deps: ModpackServiceDeps) {}

  // ---- inspect --------------------------------------------------------------

  /** Read a pack file the user picked. */
  async inspectFile(file: string): Promise<ImportSummary> {
    const entries = await listZip(file);
    const names = new Set(entries.map((e) => e.name));
    const copy = path.join(this.deps.cacheDir, "modpacks", `${randomUUID()}${path.extname(file) || ".zip"}`);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(file, copy);
    if (names.has("modrinth.index.json")) return this.summarise(await this.planFromMrpack(copy, "local", null, null));
    if (names.has("manifest.json")) return this.summarise(await this.planFromCurseForge(copy, "local", null, null));
    fs.rmSync(copy, { force: true });
    throw new Error("This is not a Modrinth (.mrpack) or CurseForge modpack: it has no modrinth.index.json or manifest.json.");
  }

  async inspectModrinth(projectId: string, versionId: string | null): Promise<ImportSummary> {
    const project = await this.deps.modrinth.project(projectId);
    if (project.project_type !== "modpack") throw new Error(`${project.title} is a ${project.project_type}, not a modpack`);
    const version = versionId ? await this.deps.modrinth.version(versionId) : (await this.deps.modrinth.versions(project.id)).find((v) => v.version_type === "release") ?? null;
    if (!version) throw new Error(`${project.title} has no release versions`);
    const file = version.files.find((f) => f.primary && f.filename.endsWith(".mrpack")) ?? version.files.find((f) => f.filename.endsWith(".mrpack"));
    if (!file) throw new Error(`${project.title} ${version.version_number} has no .mrpack file`);
    const archive = path.join(this.deps.cacheDir, "modpacks", `${randomUUID()}.mrpack`);
    await this.download(file.url, archive, `${project.title} ${version.version_number}`, file.hashes.sha512 ? { algo: "sha512", value: file.hashes.sha512 } : undefined);
    return this.summarise(await this.planFromMrpack(archive, "modrinth", project.id, version.id));
  }

  async inspectCurseForge(modId: number, fileId: number | null): Promise<ImportSummary> {
    const mod = await this.deps.curseforge.mod(modId);
    const file = fileId ? await this.deps.curseforge.file(modId, fileId) : (await this.deps.curseforge.files(modId)).find((f) => f.releaseType === 1 && !f.isServerPack);
    if (!file) throw new Error(`${mod.name} has no release files`);
    if (!file.downloadUrl) {
      throw new Error(`The author of ${mod.name} does not allow apps to download it. Download the pack from ${cfFilePage(mod, file)} and import the file.`);
    }
    const archive = path.join(this.deps.cacheDir, "modpacks", `${randomUUID()}.zip`);
    await this.download(file.downloadUrl, archive, `${mod.name} ${file.displayName}`, cfSha1(file) ? { algo: "sha1", value: cfSha1(file)! } : undefined);
    const plan = await this.planFromCurseForge(archive, "curseforge", String(mod.id), String(file.id));
    plan.name = mod.name;
    if (file.serverPackFileId) {
      try {
        const sp = await this.deps.curseforge.file(modId, file.serverPackFileId);
        if (sp.downloadUrl) plan.serverPack = { file: sp };
      } catch (err) {
        this.deps.log.warn(`Could not look up the server pack for ${mod.name}: ${(err as Error).message}`);
      }
    }
    return this.summarise(plan);
  }

  private async planFromMrpack(archive: string, source: ModpackSource, projectId: string | null, versionId: string | null): Promise<Plan> {
    const raw = await readZipEntry(archive, "modrinth.index.json", 8 * 1024 * 1024);
    if (!raw) throw new Error("modrinth.index.json is missing");
    const index = JSON.parse(raw.toString("utf8")) as {
      formatVersion: number;
      game: string;
      name: string;
      versionId: string;
      files: { path: string; hashes: { sha1?: string; sha512?: string }; env?: { client?: string; server?: string }; downloads: string[]; fileSize: number }[];
      dependencies: Record<string, string>;
    };
    if (index.formatVersion !== 1 || index.game !== "minecraft") throw new Error("This .mrpack uses a format NexCraft does not understand");
    const deps = index.dependencies ?? {};
    const minecraftVersion = deps.minecraft;
    if (!minecraftVersion) throw new Error("The pack does not say which Minecraft version it needs");
    const loader = deps["fabric-loader"]
      ? { type: "fabric" as const, version: deps["fabric-loader"] }
      : deps["quilt-loader"]
        ? { type: "quilt" as const, version: deps["quilt-loader"] }
        : deps.neoforge
          ? { type: "neoforge" as const, version: deps.neoforge }
          : deps.forge
            ? { type: "forge" as const, version: deps.forge }
            : null;
    const warnings: string[] = [];
    const files: PackFile[] = [];
    for (const f of index.files ?? []) {
      resolveInside("/pack", f.path); // throws on unsafe paths before anything is written
      const server = f.env?.server;
      const client = f.env?.client;
      const side: Side = server === "unsupported" ? "client" : client === "unsupported" ? "server" : server ? "both" : "unknown";
      const url = f.downloads.find(isAllowedMrpackUrl) ?? null;
      if (!url && side !== "client") warnings.push(`${f.path} can only be downloaded from a site Modrinth packs are not allowed to use, so it was left out`);
      files.push({ path: f.path, name: path.posix.basename(f.path), size: f.fileSize, sha1: f.hashes.sha1, sha512: f.hashes.sha512, url, side });
    }
    return {
      id: randomUUID(),
      name: index.name,
      version: index.versionId,
      source,
      projectId,
      versionId,
      minecraftVersion,
      loader,
      archive,
      overrides: ["overrides/", "server-overrides/"],
      files,
      serverPack: null,
      warnings,
    };
  }

  private async planFromCurseForge(archive: string, source: ModpackSource, projectId: string | null, versionId: string | null): Promise<Plan> {
    const raw = await readZipEntry(archive, "manifest.json", 8 * 1024 * 1024);
    if (!raw) throw new Error("manifest.json is missing");
    const manifest = JSON.parse(raw.toString("utf8").replace(/^﻿/, "")) as {
      manifestType: string;
      name: string;
      version: string;
      overrides?: string;
      minecraft: { version: string; modLoaders: { id: string; primary: boolean }[] };
      files: { projectID: number; fileID: number; required: boolean }[];
    };
    if (manifest.manifestType !== "minecraftModpack") throw new Error("manifest.json is not a CurseForge Minecraft modpack");
    const primary = manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0];
    const loader = primary ? parseCfLoader(primary.id) : null;
    if (primary && !loader) throw new Error(`The pack uses ${primary.id}, which NexCraft cannot install`);
    const warnings: string[] = [];
    const files: PackFile[] = [];
    const wanted = manifest.files.filter((f) => f.required !== false);
    if (wanted.length) {
      if (!this.deps.curseforge.available()) throw new Error("This CurseForge pack lists mods by ID, so NexCraft needs a CurseForge API key to download them. Add one in Settings.");
      const [cfFiles, mods] = await Promise.all([this.deps.curseforge.filesById(wanted.map((f) => f.fileID)), this.deps.curseforge.mods([...new Set(wanted.map((f) => f.projectID))])]);
      const modById = new Map(mods.map((m) => [m.id, m]));
      for (const want of wanted) {
        const file = cfFiles.find((f) => f.id === want.fileID);
        const mod = modById.get(want.projectID) ?? null;
        if (!file) {
          warnings.push(`CurseForge no longer has file ${want.fileID} of project ${mod?.name ?? want.projectID}`);
          continue;
        }
        if (mod && mod.classId !== CLASS_MODS) continue; // resource packs and shaders are only used by game clients
        const pf: PackFile = {
          path: `mods/${file.fileName}`,
          name: mod ? `${mod.name} (${file.fileName})` : file.fileName,
          size: file.fileLength,
          sha1: cfSha1(file),
          url: file.downloadUrl,
          side: cfSide(file),
        };
        resolveInside("/pack", pf.path);
        if (!file.downloadUrl) pf.manualPage = cfFilePage(mod, file);
        files.push(pf);
      }
    }
    return {
      id: randomUUID(),
      name: manifest.name,
      version: manifest.version,
      source,
      projectId,
      versionId,
      minecraftVersion: manifest.minecraft.version,
      loader,
      archive,
      overrides: [`${(manifest.overrides || "overrides").replace(/\/?$/, "/")}`],
      files,
      serverPack: null,
      warnings,
    };
  }

  private summarise(plan: Plan): ImportSummary {
    this.plans.set(plan.id, plan);
    const server = plan.files.filter((f) => f.side !== "client");
    return {
      id: plan.id,
      name: plan.name,
      version: plan.version,
      source: plan.source,
      minecraftVersion: plan.minecraftVersion,
      loader: plan.loader,
      fileCount: plan.files.length,
      serverFileCount: server.filter((f) => !f.manualPage && f.url).length,
      clientOnly: plan.files.filter((f) => f.side === "client").map((f) => f.name),
      unknownSide: server.filter((f) => f.side === "unknown").length,
      manual: server.filter((f) => f.manualPage).map((f) => ({ name: f.name, path: f.path, page: f.manualPage!, sha1: f.sha1 ?? null })),
      serverPack: plan.serverPack ? { fileName: plan.serverPack.file.fileName, size: plan.serverPack.file.fileLength } : null,
      warnings: plan.warnings,
    };
  }

  // ---- install --------------------------------------------------------------

  async install(planId: string, opts: InstallOptions, progressKey: string, report: (message: string) => void): Promise<{ server: ServerInstance; clientOnlyRemoved: string[]; manual: ManualFile[] }> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("This import has expired. Inspect the pack again.");
    const server = await this.deps.servers.create(
      {
        name: opts.name,
        minecraftVersion: plan.minecraftVersion,
        type: plan.loader?.type ?? "vanilla",
        loaderVersion: plan.loader?.version ?? null,
        memoryMb: opts.memoryMb,
        port: opts.port,
        parentDir: opts.parentDir ?? "",
        javaRuntimeId: opts.javaRuntimeId ?? null,
        motd: plan.name.slice(0, 150),
      },
      progressKey,
    );
    const dir = server.directory;
    try {
      const useServerPack = opts.useServerPack && plan.serverPack;
      if (useServerPack) {
        report("Downloading the official server pack");
        await this.applyServerPack(plan, dir);
      } else {
        const toFetch = plan.files.filter((f) => f.side !== "client" && f.url && !f.manualPage);
        let done = 0;
        report(`Downloading ${toFetch.length} files`);
        const results = await Promise.allSettled(
          toFetch.map(async (f) => {
            const dest = resolveInside(dir, f.path);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const hash = f.sha512 ? { algo: "sha512" as const, value: f.sha512 } : f.sha1 ? { algo: "sha1" as const, value: f.sha1 } : undefined;
            await this.download(f.url!, dest, f.name, hash, f.size);
            done++;
            if (done % 10 === 0 || done === toFetch.length) report(`Downloaded ${done} of ${toFetch.length} files`);
          }),
        );
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failed.length) throw new Error(`${failed.length} file(s) could not be downloaded. First error: ${(failed[0].reason as Error).message}`);
        report("Applying the pack's settings and configs");
        for (const prefix of plan.overrides) {
          await extractZip(plan.archive, dir, { stripPrefix: prefix, overwrite: true });
        }
      }

      report("Checking mods for client-only ones");
      const clientOnlyRemoved = await this.setAsideClientOnly(dir);
      const manual: ManualFile[] = useServerPack
        ? []
        : plan.files.filter((f) => f.side !== "client" && f.manualPage).map((f) => ({ name: f.name, path: f.path, page: f.manualPage!, sha1: f.sha1 ?? null }));
      if (manual.length) {
        fs.mkdirSync(path.join(dir, ".nexcraft"), { recursive: true });
        fs.writeFileSync(path.join(dir, MANUAL_FILE), JSON.stringify(manual, null, 2));
      }
      const updated: ServerInstance = {
        ...this.deps.state.server(server.id)!,
        modpack: { source: plan.source, projectId: plan.projectId, versionId: plan.versionId, name: `${plan.name} ${plan.version}`.trim() },
      };
      this.deps.state.upsertServer(updated);
      this.deps.log.info(`Imported ${plan.name} ${plan.version} into "${server.name}" (${clientOnlyRemoved.length} client-only set aside, ${manual.length} to download by hand)`);
      return { server: updated, clientOnlyRemoved, manual };
    } catch (err) {
      // The server folder was created for this import a moment ago; remove the half-finished server.
      this.deps.state.removeServer(server.id);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      throw err;
    } finally {
      fs.rmSync(plan.archive, { force: true });
      this.plans.delete(planId);
    }
  }

  /** Files the user still has to download by hand for a server, if any. */
  manualFiles(server: ServerInstance): ManualFile[] {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(server.directory, MANUAL_FILE), "utf8")) as ManualFile[];
      return list.filter((f) => !fs.existsSync(resolveInside(server.directory, f.path)));
    } catch {
      return [];
    }
  }

  /** Copy files the user downloaded into place, accepting only exact matches by SHA-1 or name. */
  addManualFiles(server: ServerInstance, picked: string[]): { added: string[]; rejected: string[] } {
    const pending = this.manualFiles(server);
    const added: string[] = [];
    const rejected: string[] = [];
    for (const file of picked) {
      const sha1 = createHash("sha1").update(fs.readFileSync(file)).digest("hex");
      const match = pending.find((p) => (p.sha1 ? p.sha1 === sha1 : path.posix.basename(p.path) === path.basename(file)));
      if (!match) {
        rejected.push(path.basename(file));
        continue;
      }
      const dest = resolveInside(server.directory, match.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      added.push(match.name);
    }
    return { added, rejected };
  }

  private async applyServerPack(plan: Plan, dir: string) {
    const sp = plan.serverPack!.file;
    const archive = path.join(this.deps.cacheDir, "modpacks", `${randomUUID()}-server.zip`);
    await this.download(sp.downloadUrl!, archive, sp.fileName, cfSha1(sp) ? { algo: "sha1", value: cfSha1(sp)! } : undefined, sp.fileLength);
    try {
      const names = (await listZip(archive)).map((e) => e.name);
      const tops = new Set(names.map((n) => n.split("/")[0]));
      const prefix = tops.size === 1 && names.every((n) => n.includes("/")) ? `${[...tops][0]}/` : "";
      // Keep the pack's mods, configs and data; NexCraft has already installed the loader,
      // and the pack's own start scripts and installers are not needed.
      await extractZip(archive, dir, {
        stripPrefix: prefix || undefined,
        overwrite: true,
        filter: (n) => !/^(libraries|versions)\//i.test(n) && !/^[^/]+\.(jar|bat|cmd|sh|ps1|exe|command)$/i.test(n) && !/^(eula\.txt|server\.properties)$/i.test(n),
      });
    } finally {
      fs.rmSync(archive, { force: true });
    }
  }

  /** Move mods whose metadata says "client only" out of the mods folder, keeping them for the user. */
  private async setAsideClientOnly(dir: string): Promise<string[]> {
    const modsDir = path.join(dir, "mods");
    if (!fs.existsSync(modsDir)) return [];
    const moved: string[] = [];
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.endsWith(".jar")) continue;
      const file = path.join(modsDir, name);
      try {
        const meta = await readModMetadata(file);
        if (meta?.environment === "client") {
          const target = path.join(dir, CLIENT_ONLY_DIR, name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(file, target);
          moved.push(meta.name || name);
        }
      } catch (err) {
        this.deps.log.debug(`Could not read ${name}: ${(err as Error).message}`);
      }
    }
    return moved;
  }

  private async download(url: string, dest: string, title: string, hash?: { algo: "sha1" | "sha512"; value: string }, size?: number) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const { done } = this.deps.downloads.enqueue({ url, dest, title: toSafeName(title, "download"), hash, size });
    const result = await done;
    if (!result.ok) throw new Error(result.cancelled ? `${title}: download cancelled` : `${title}: ${result.error}`);
  }
}

export function parseCfLoader(id: string): { type: LoaderType; version: string } | null {
  const m = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(id.trim());
  if (!m) return null;
  const type = m[1].toLowerCase() as LoaderType;
  // Old NeoForge 1.20.1 packs say "neoforge-1.20.1-47.1.x"; that artifact is not supported.
  return { type, version: m[2] };
}
