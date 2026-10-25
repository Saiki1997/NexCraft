/**
 * Manage the mods of one server: list them with a compatibility label, add them
 * from Modrinth or CurseForge with their required dependencies, update, switch
 * on and off, remove, and undo any of those changes.
 *
 * Every change is recorded in `.nexcraft/mod-history/<id>/`. Files a change
 * replaces or removes are moved there, never deleted, so undo puts them back.
 * Changes need the server to be stopped: Windows locks jars a running server has
 * open, and a half-changed mods folder is worse than waiting.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerInstance } from "../../shared/model";
import type { ManualFile, PackSearchHit } from "../../shared/modpacks";
import type { InstalledMod, ModChangePlan, ModHistoryEntry, ModList, ModProvider, ModSource, ModUpdate, PlannedFile } from "../../shared/mods";
import type { DownloadQueue } from "../core/download-queue";
import type { ScopedLogger } from "../core/logger";
import { resolveInside, toSafeName } from "../core/safe-path";
import { LOADER_NAMES, type LoaderType } from "../loaders/loaders";
import { cfFilePage, cfSha1, cfSide, type CfFile, type CurseForgeClient } from "../providers/curseforge";
import { isAllowedMrpackUrl, type ModrinthClient, type ModrinthVersion } from "../providers/modrinth";
import { searchModpacks } from "../providers/search";
import type { ServerService } from "../servers/server-service";
import type { StateService } from "../services/state-service";
import { assessMods, loadersAccepted, type ModFacts } from "./compatibility";
import { readModMetadata, type ModMetadata } from "./mod-metadata";

export interface ModServiceDeps {
  state: Pick<StateService, "server">;
  servers: Pick<ServerService, "status">;
  downloads: Pick<DownloadQueue, "enqueue">;
  modrinth: Pick<ModrinthClient, "search" | "project" | "projects" | "versions" | "version" | "versionsByHash" | "updatesByHash">;
  curseforge: Pick<CurseForgeClient, "available" | "search" | "mod" | "files" | "file">;
  log: ScopedLogger;
}

/** What NexCraft remembers about files it installed, keyed by file name without ".disabled". */
interface StoredSource extends ModSource {
  sha1: string;
  gameVersions: string[];
  loaders: string[];
}

interface StoredEntry {
  id: string;
  at: string;
  summary: string;
  undone: boolean;
  added: { file: string; sha1: string }[];
  /** Files moved into the entry's folder; `stored` is the name there. */
  removed: { file: string; sha1: string; stored: string }[];
  renamed: { from: string; to: string }[];
}

interface PlanDownload extends PlannedFile {
  url: string;
  sha1: string | null;
  sha512: string | null;
  size: number;
  page: string;
  gameVersions: string[];
  loaders: string[];
}

interface StoredPlan extends ModChangePlan {
  downloads: PlanDownload[];
}

const SOURCES_FILE = path.join(".nexcraft", "mod-sources.json");
const HISTORY_DIR = path.join(".nexcraft", "mod-history");
const MANUAL_FILE = path.join(".nexcraft", "manual-downloads.json");
const KEEP_HISTORY = 40;
const MAX_DEPENDENCY_DEPTH = 6;

export class ModService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly fileCache = new Map<string, { key: string; sha1: string; meta: ModMetadata | null }>();
  private readonly modrinthByHash = new Map<string, ModrinthVersion | null>();
  private readonly icons = new Map<string, string | null>();

  constructor(private readonly deps: ModServiceDeps) {}

  // ---- reading ---------------------------------------------------------------

  async list(serverId: string): Promise<ModList> {
    const server = this.moddedServer(serverId);
    const files = this.modFiles(server);
    const local = await Promise.all(files.map((f) => this.inspectFile(path.join(server.directory, "mods", f))));
    const sources = this.readSources(server);

    let providerChecked = true;
    const unknown = local.map((l) => l.sha1).filter((h) => !this.modrinthByHash.has(h));
    if (unknown.length) {
      try {
        const found = await this.deps.modrinth.versionsByHash(unknown);
        for (const h of unknown) this.modrinthByHash.set(h, found[h] ?? null);
      } catch (err) {
        providerChecked = false;
        this.deps.log.debug(`Modrinth lookup failed: ${(err as Error).message}`);
      }
    }
    await this.loadIcons(local.map((l) => this.modrinthByHash.get(l.sha1)?.project_id).filter((id): id is string => Boolean(id)));

    const facts: ModFacts[] = files.map((file, i) => {
      const mr = this.modrinthByHash.get(local[i].sha1);
      const stored = sources[baseName(file)];
      const cf = stored?.provider === "curseforge" && stored.sha1 === local[i].sha1 ? stored : null;
      return {
        file,
        enabled: !file.endsWith(".disabled"),
        meta: local[i].meta,
        provider: mr ? { name: "Modrinth", gameVersions: mr.game_versions, loaders: mr.loaders } : cf ? { name: "CurseForge", gameVersions: cf.gameVersions, loaders: cf.loaders } : null,
      };
    });
    const assessed = assessMods(target(server), facts);

    const mods: InstalledMod[] = files.map((file, i) => {
      const mr = this.modrinthByHash.get(local[i].sha1);
      const stored = sources[baseName(file)];
      const source: ModSource | null = mr
        ? { provider: "modrinth", projectId: mr.project_id, versionId: mr.id, page: `https://modrinth.com/project/${mr.project_id}` }
        : stored && stored.sha1 === local[i].sha1
          ? { provider: stored.provider, projectId: stored.projectId, versionId: stored.versionId, page: stored.page }
          : null;
      const meta = local[i].meta;
      return {
        file,
        enabled: facts[i].enabled,
        size: local[i].size,
        sha1: local[i].sha1,
        id: meta?.id ?? null,
        name: meta?.name || baseName(file).replace(/\.jar$/i, ""),
        version: meta?.version || mr?.version_number || null,
        environment: meta?.environment ?? "unknown",
        label: assessed[i].label,
        reasons: assessed[i].reasons,
        source,
        iconUrl: mr ? (this.icons.get(mr.project_id) ?? null) : null,
      };
    });
    mods.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return { mods, providerChecked };
  }

  async search(serverId: string, provider: ModProvider, query: string): Promise<PackSearchHit[]> {
    const server = this.moddedServer(serverId);
    const loader = server.type as LoaderType;
    return searchModpacks(this.deps.modrinth, this.deps.curseforge, {
      source: provider,
      kind: "mod",
      query,
      gameVersion: server.minecraftVersion,
      modrinthLoaders: loadersAccepted(loader),
      // CurseForge filters by one loader; Quilt servers run Fabric mods, which is where most are.
      loader: loader === "quilt" ? "fabric" : loader,
    });
  }

  /** Versions of a mod that fit this server, newest first. */
  async versions(serverId: string, provider: ModProvider, projectId: string) {
    const server = this.moddedServer(serverId);
    if (provider === "modrinth") {
      const list = await this.deps.modrinth.versions(projectId, { loaders: loadersAccepted(server.type as LoaderType), gameVersions: [server.minecraftVersion] });
      return list.map((v) => ({ id: v.id, name: v.version_number || v.name, gameVersions: v.game_versions, loaders: v.loaders, date: v.date_published, stable: v.version_type === "release" }));
    }
    return (await this.cfCandidates(server, Number(projectId))).map((f) => ({
      id: String(f.id),
      name: f.displayName,
      gameVersions: f.gameVersions.filter((g) => /^\d/.test(g)),
      loaders: f.gameVersions.map((g) => g.toLowerCase()).filter((g) => g in LOADER_NAMES),
      date: f.fileDate,
      stable: f.releaseType === 1,
    }));
  }

  // ---- planning --------------------------------------------------------------

  /** Work out what adding a mod means: which file, and which required mods come with it. */
  async planAdd(serverId: string, provider: ModProvider, projectId: string, versionId: string | null): Promise<ModChangePlan> {
    const server = this.moddedServer(serverId);
    const installed = await this.list(serverId);
    const b = new PlanBuilder(server, installed.mods);
    if (provider === "modrinth") await this.resolveModrinth(b, projectId, versionId, "requested", null, 0);
    else await this.resolveCurseForge(b, Number(projectId), versionId ? Number(versionId) : null, "requested", null, 0);
    return this.storePlan(serverId, b);
  }

  async checkUpdates(serverId: string): Promise<ModUpdate[]> {
    const server = this.moddedServer(serverId);
    const { mods } = await this.list(serverId);
    const updates: ModUpdate[] = [];
    const fromModrinth = mods.filter((m) => m.source?.provider === "modrinth");
    if (fromModrinth.length) {
      const found = await this.deps.modrinth.updatesByHash(
        fromModrinth.map((m) => m.sha1),
        loadersAccepted(server.type as LoaderType),
        [server.minecraftVersion],
      );
      for (const m of fromModrinth) {
        const v = found[m.sha1];
        if (v && v.id !== m.source!.versionId && v.project_id === m.source!.projectId) {
          updates.push({ file: m.file, name: m.name, currentVersion: m.version, newVersion: v.version_number, provider: "modrinth", projectId: v.project_id, versionId: v.id });
        }
      }
    }
    const fromCurseForge = mods.filter((m) => m.source?.provider === "curseforge");
    if (fromCurseForge.length && this.deps.curseforge.available()) {
      for (const m of fromCurseForge) {
        const files = await this.cfCandidates(server, Number(m.source!.projectId));
        const newest = files[0];
        if (newest && String(newest.id) !== m.source!.versionId && newest.id > Number(m.source!.versionId)) {
          updates.push({ file: m.file, name: m.name, currentVersion: m.version, newVersion: newest.displayName, provider: "curseforge", projectId: m.source!.projectId, versionId: String(newest.id) });
        }
      }
    }
    return updates;
  }

  async planUpdate(serverId: string, updates: Pick<ModUpdate, "file" | "provider" | "projectId" | "versionId">[]): Promise<ModChangePlan> {
    const server = this.moddedServer(serverId);
    const installed = await this.list(serverId);
    const b = new PlanBuilder(server, installed.mods);
    for (const u of updates) {
      this.modFile(server, u.file);
      if (u.provider === "modrinth") await this.resolveModrinth(b, u.projectId, u.versionId, "update", u.file, 0);
      else await this.resolveCurseForge(b, Number(u.projectId), Number(u.versionId), "update", u.file, 0);
    }
    return this.storePlan(serverId, b);
  }

  private async resolveModrinth(b: PlanBuilder, projectId: string, versionId: string | null, reason: PlannedFile["reason"], replaces: string | null, depth: number) {
    if (b.seen(`modrinth:${projectId}`) || depth > MAX_DEPENDENCY_DEPTH) return;
    const project = await this.deps.modrinth.project(projectId);
    const installed = b.installedProject("modrinth", project.id);
    if (reason === "dependency" && installed) return;
    if (project.server_side === "unsupported") {
      if (reason === "dependency") b.warnings.push(`${project.title} is needed by another mod but only runs in the game client, so it was left out.`);
      else throw new Error(`${project.title} only runs in the game client, so it cannot be added to a server.`);
      return;
    }
    const version = versionId
      ? await this.deps.modrinth.version(versionId)
      : pickModrinthVersion(await this.deps.modrinth.versions(project.id, { loaders: b.loaders, gameVersions: [b.server.minecraftVersion] }));
    if (!version) {
      const msg = `${project.title} has no version for Minecraft ${b.server.minecraftVersion} on ${b.loaderName}.`;
      if (reason === "requested") throw new Error(msg);
      b.warnings.push(`${msg} A mod you are adding needs it.`);
      return;
    }
    if (installed && installed.source?.versionId === version.id && reason !== "update") throw new Error(`${project.title} ${version.version_number} is already installed.`);
    const file = version.files.find((f) => f.primary) ?? version.files[0];
    if (!file || !isAllowedMrpackUrl(file.url)) throw new Error(`${project.title}: Modrinth gave no usable download for this version.`);
    b.files.push({
      name: project.title,
      version: version.version_number,
      fileName: safeJarName(file.filename),
      provider: "modrinth",
      projectId: project.id,
      versionId: version.id,
      reason,
      replaces: replaces ?? installed?.file ?? null,
      url: file.url,
      sha1: file.hashes.sha1 ?? null,
      sha512: file.hashes.sha512 ?? null,
      size: file.size,
      page: `https://modrinth.com/project/${project.slug || project.id}`,
      gameVersions: version.game_versions,
      loaders: version.loaders,
    });
    for (const dep of version.dependencies) {
      let depProject = dep.project_id;
      if (!depProject && dep.version_id) depProject = (await this.deps.modrinth.version(dep.version_id)).project_id;
      if (!depProject) continue;
      if (dep.dependency_type === "required") await this.resolveModrinth(b, depProject, null, "dependency", null, depth + 1);
      else if (dep.dependency_type === "incompatible") {
        const clash = b.installedProject("modrinth", depProject);
        if (clash) b.warnings.push(`${project.title} says it does not work with ${clash.name}, which is installed.`);
      }
    }
  }

  private async resolveCurseForge(b: PlanBuilder, modId: number, fileId: number | null, reason: PlannedFile["reason"], replaces: string | null, depth: number) {
    if (b.seen(`curseforge:${modId}`) || depth > MAX_DEPENDENCY_DEPTH) return;
    const mod = await this.deps.curseforge.mod(modId);
    const installed = b.installedProject("curseforge", String(modId));
    if (reason === "dependency" && installed) return;
    const file = fileId ? await this.deps.curseforge.file(modId, fileId) : (await this.cfCandidates(b.server, modId))[0];
    if (!file) {
      const msg = `${mod.name} has no file for Minecraft ${b.server.minecraftVersion} on ${b.loaderName}.`;
      if (reason === "requested") throw new Error(msg);
      b.warnings.push(`${msg} A mod you are adding needs it.`);
      return;
    }
    if (cfSide(file) === "client") {
      if (reason === "dependency") b.warnings.push(`${mod.name} is needed by another mod but only runs in the game client, so it was left out.`);
      else throw new Error(`${mod.name} only runs in the game client, so it cannot be added to a server.`);
      return;
    }
    if (installed && installed.source?.versionId === String(file.id) && reason !== "update") throw new Error(`${mod.name} ${file.displayName} is already installed.`);
    const fileName = safeJarName(file.fileName);
    const page = cfFilePage(mod, file);
    if (!file.downloadUrl) {
      // The author does not allow apps to download this file. Point the user at it instead.
      b.manual.push({ name: `${mod.name} (${file.displayName})`, path: `mods/${fileName}`, page, sha1: cfSha1(file) ?? null });
    } else {
      b.files.push({
        name: mod.name,
        version: file.displayName,
        fileName,
        provider: "curseforge",
        projectId: String(modId),
        versionId: String(file.id),
        reason,
        replaces: replaces ?? installed?.file ?? null,
        url: file.downloadUrl,
        sha1: cfSha1(file) ?? null,
        sha512: null,
        size: file.fileLength,
        page: mod.links.websiteUrl || page,
        gameVersions: file.gameVersions.filter((g) => /^\d/.test(g)),
        loaders: file.gameVersions.map((g) => g.toLowerCase()).filter((g) => g in LOADER_NAMES),
      });
    }
    // relationType 3 = required dependency, 5 = incompatible.
    for (const dep of file.dependencies) {
      if (dep.relationType === 3) await this.resolveCurseForge(b, dep.modId, null, "dependency", null, depth + 1);
      else if (dep.relationType === 5) {
        const clash = b.installedProject("curseforge", String(dep.modId));
        if (clash) b.warnings.push(`${mod.name} says it does not work with ${clash.name}, which is installed.`);
      }
    }
  }

  /** Server-usable files of a CurseForge mod for this server, newest and most stable first. */
  private async cfCandidates(server: ServerInstance, modId: number): Promise<CfFile[]> {
    const loaders = loadersAccepted(server.type as LoaderType);
    const all: CfFile[] = [];
    for (const loader of loaders) all.push(...(await this.deps.curseforge.files(modId, { gameVersion: server.minecraftVersion, loader })));
    return all
      .filter((f) => !f.isServerPack && cfSide(f) !== "client")
      .sort((a, b) => (a.releaseType === b.releaseType ? Date.parse(b.fileDate) - Date.parse(a.fileDate) : a.releaseType - b.releaseType));
  }

  private storePlan(serverId: string, b: PlanBuilder): ModChangePlan {
    if (!b.files.length && !b.manual.length) throw new Error("Nothing to change: everything is already installed.");
    const plan: StoredPlan = {
      id: randomUUID(),
      serverId,
      files: b.files.map(({ name, version, fileName, provider, projectId, versionId, reason, replaces }) => ({ name, version, fileName, provider, projectId, versionId, reason, replaces })),
      manual: b.manual,
      warnings: b.warnings,
      downloads: b.files,
    };
    this.plans.set(plan.id, plan);
    const { downloads: _downloads, ...visible } = plan;
    return visible;
  }

  // ---- changing --------------------------------------------------------------

  async apply(planId: string): Promise<{ summary: string }> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("This change has expired. Look at it again before applying.");
    const server = this.moddedServer(plan.serverId);
    this.ensureStopped(server);
    const entry = this.newEntry(server);
    const incoming = path.join(this.entryDir(server, entry.id), "incoming");
    try {
      await Promise.all(
        plan.downloads.map((d) =>
          this.download(d.url, path.join(incoming, d.fileName), d.name, d.sha512 ? { algo: "sha512", value: d.sha512 } : d.sha1 ? { algo: "sha1", value: d.sha1 } : undefined, d.size, server.id),
        ),
      );
    } catch (err) {
      fs.rmSync(this.entryDir(server, entry.id), { recursive: true, force: true });
      throw err;
    }

    const modsDir = path.join(server.directory, "mods");
    fs.mkdirSync(modsDir, { recursive: true });
    const sources = this.readSources(server);
    for (const d of plan.downloads) {
      // An updated mod that was switched off stays switched off.
      const disabled = d.replaces?.endsWith(".disabled") ?? false;
      const finalName = disabled ? `${d.fileName}.disabled` : d.fileName;
      if (d.replaces && fs.existsSync(path.join(modsDir, d.replaces))) this.moveToHistory(server, entry, d.replaces);
      for (const clash of [d.fileName, `${d.fileName}.disabled`]) if (fs.existsSync(path.join(modsDir, clash))) this.moveToHistory(server, entry, clash);
      fs.renameSync(path.join(incoming, d.fileName), path.join(modsDir, finalName));
      const sha1 = sha1Of(path.join(modsDir, finalName));
      entry.added.push({ file: finalName, sha1 });
      sources[d.fileName] = { provider: d.provider, projectId: d.projectId, versionId: d.versionId, page: d.page, sha1, gameVersions: d.gameVersions, loaders: d.loaders };
    }
    fs.rmSync(incoming, { recursive: true, force: true });
    if (plan.manual.length) this.addManualFiles(server, plan.manual);
    this.writeSources(server, sources);

    const updated = plan.files.filter((f) => f.reason === "update").length;
    const added = plan.files.length - updated;
    entry.summary = describe([
      added && `Added ${names(plan.files.filter((f) => f.reason !== "update").map((f) => f.name))}`,
      updated && `Updated ${names(plan.files.filter((f) => f.reason === "update").map((f) => f.name))}`,
      plan.manual.length && `${plan.manual.length} to download by hand`,
    ]);
    this.saveEntry(server, entry);
    this.plans.delete(planId);
    return { summary: entry.summary };
  }

  async addFiles(serverId: string, picked: string[]): Promise<{ added: string[]; rejected: string[] }> {
    const server = this.moddedServer(serverId);
    this.ensureStopped(server);
    const modsDir = path.join(server.directory, "mods");
    fs.mkdirSync(modsDir, { recursive: true });
    const entry = this.newEntry(server);
    const added: string[] = [];
    const rejected: string[] = [];
    for (const file of picked) {
      const name = safeJarName(path.basename(file));
      // Only accept real jars; a renamed text file would only make the server fail to start.
      const meta = /\.jar$/i.test(file) ? await readModMetadata(file).catch(() => undefined) : undefined;
      if (meta === undefined) {
        rejected.push(path.basename(file));
        continue;
      }
      for (const clash of [name, `${name}.disabled`]) if (fs.existsSync(path.join(modsDir, clash))) this.moveToHistory(server, entry, clash);
      fs.copyFileSync(file, path.join(modsDir, name));
      entry.added.push({ file: name, sha1: sha1Of(path.join(modsDir, name)) });
      added.push(meta?.name ?? name);
    }
    if (entry.added.length) {
      entry.summary = `Added ${names(added)} from files`;
      this.saveEntry(server, entry);
    } else fs.rmSync(this.entryDir(server, entry.id), { recursive: true, force: true });
    return { added, rejected };
  }

  setEnabled(serverId: string, files: string[], enabled: boolean): { summary: string } {
    const server = this.moddedServer(serverId);
    this.ensureStopped(server);
    const entry = this.newEntry(server);
    const modsDir = path.join(server.directory, "mods");
    const changed: string[] = [];
    for (const file of files) {
      this.modFile(server, file);
      const isOn = !file.endsWith(".disabled");
      if (isOn === enabled) continue;
      const to = enabled ? file.replace(/\.disabled$/, "") : `${file}.disabled`;
      if (fs.existsSync(path.join(modsDir, to))) throw new Error(`${to} already exists in the mods folder.`);
      fs.renameSync(path.join(modsDir, file), path.join(modsDir, to));
      entry.renamed.push({ from: file, to });
      changed.push(this.displayName(server, file));
    }
    if (!changed.length) {
      fs.rmSync(this.entryDir(server, entry.id), { recursive: true, force: true });
      return { summary: "Nothing changed" };
    }
    entry.summary = `${enabled ? "Switched on" : "Switched off"} ${names(changed)}`;
    this.saveEntry(server, entry);
    return { summary: entry.summary };
  }

  remove(serverId: string, files: string[]): { summary: string } {
    const server = this.moddedServer(serverId);
    this.ensureStopped(server);
    files.forEach((f) => this.modFile(server, f));
    const shown = files.map((f) => this.displayName(server, f));
    const entry = this.newEntry(server);
    for (const file of files) this.moveToHistory(server, entry, file);
    entry.summary = `Removed ${names(shown)}`;
    this.saveEntry(server, entry);
    return { summary: entry.summary };
  }

  history(serverId: string): ModHistoryEntry[] {
    const server = this.moddedServer(serverId);
    return this.entries(server).map((e) => ({ id: e.id, at: e.at, summary: e.summary, undone: e.undone, canUndo: !e.undone && this.undoProblem(server, e) === null }));
  }

  undo(serverId: string, entryId: string): { summary: string } {
    const server = this.moddedServer(serverId);
    this.ensureStopped(server);
    const entry = this.entries(server).find((e) => e.id === entryId);
    if (!entry || entry.undone) throw new Error("That change was already undone or no longer exists.");
    const problem = this.undoProblem(server, entry);
    if (problem) throw new Error(problem);
    const modsDir = path.join(server.directory, "mods");
    const dir = this.entryDir(server, entry.id);
    const setAside = path.join(dir, "undone");
    fs.mkdirSync(setAside, { recursive: true });
    for (const a of entry.added) fs.renameSync(path.join(modsDir, a.file), path.join(setAside, a.file));
    for (const r of [...entry.renamed].reverse()) fs.renameSync(path.join(modsDir, r.to), path.join(modsDir, r.from));
    for (const r of entry.removed) fs.renameSync(path.join(dir, "removed", r.stored), path.join(modsDir, r.file));
    entry.undone = true;
    this.writeEntry(server, entry);
    return { summary: `Undid: ${entry.summary}` };
  }

  /** Why an entry cannot be undone any more, or null when it can. */
  private undoProblem(server: ServerInstance, e: StoredEntry): string | null {
    const modsDir = path.join(server.directory, "mods");
    const dir = this.entryDir(server, e.id);
    for (const a of e.added) {
      const f = path.join(modsDir, a.file);
      if (!fs.existsSync(f) || this.cachedSha1(f) !== a.sha1) return `${a.file} has changed since, so undoing would lose that change.`;
    }
    for (const r of e.renamed) if (!fs.existsSync(path.join(modsDir, r.to)) || fs.existsSync(path.join(modsDir, r.from))) return `${r.from} has changed since.`;
    const addedNames = new Set(e.added.map((a) => a.file));
    for (const r of e.removed) {
      if (!fs.existsSync(path.join(dir, "removed", r.stored))) return `The saved copy of ${r.file} is missing.`;
      if (!addedNames.has(r.file) && fs.existsSync(path.join(modsDir, r.file))) return `${r.file} is back in the mods folder already.`;
    }
    return null;
  }

  // ---- helpers ---------------------------------------------------------------

  /** The mod's own name when NexCraft has read it, otherwise the file name. */
  private displayName(server: ServerInstance, file: string) {
    return this.fileCache.get(path.join(server.directory, "mods", file))?.meta?.name || baseName(file).replace(/\.jar$/i, "");
  }

  private moddedServer(id: string): ServerInstance {
    const server = this.deps.state.server(id);
    if (!server) throw new Error("That server no longer exists");
    if (server.type === "vanilla") throw new Error("Vanilla servers cannot run mods. Create a Fabric, Quilt, Forge or NeoForge server.");
    return server;
  }

  private ensureStopped(server: ServerInstance) {
    const state = this.deps.servers.status(server.id).state;
    if (state !== "stopped" && state !== "crashed") throw new Error(`Stop ${server.name} before changing its mods.`);
  }

  private modFiles(server: ServerInstance): string[] {
    const dir = path.join(server.directory, "mods");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.jar(\.disabled)?$/i.test(d.name))
      .map((d) => d.name);
  }

  /** Check a file name from the UI names a mod in this server's mods folder. */
  private modFile(server: ServerInstance, file: string): string {
    if (path.basename(file) !== file || !/\.jar(\.disabled)?$/i.test(file)) throw new Error(`${file} is not a mod file`);
    const full = resolveInside(path.join(server.directory, "mods"), file);
    if (!fs.existsSync(full)) throw new Error(`${file} is no longer in the mods folder`);
    return full;
  }

  private async inspectFile(file: string): Promise<{ sha1: string; size: number; meta: ModMetadata | null }> {
    const st = fs.statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const cached = this.fileCache.get(file);
    if (cached?.key === key) return { sha1: cached.sha1, size: st.size, meta: cached.meta };
    const sha1 = sha1Of(file);
    const meta = await readModMetadata(file).catch((err: Error) => {
      this.deps.log.debug(`Could not read ${path.basename(file)}: ${err.message}`);
      return null;
    });
    this.fileCache.set(file, { key, sha1, meta });
    return { sha1, size: st.size, meta };
  }

  private cachedSha1(file: string) {
    const st = fs.statSync(file);
    const cached = this.fileCache.get(file);
    return cached?.key === `${st.size}:${st.mtimeMs}` ? cached.sha1 : sha1Of(file);
  }

  private async loadIcons(projectIds: string[]) {
    const missing = [...new Set(projectIds)].filter((id) => !this.icons.has(id));
    if (!missing.length) return;
    try {
      const projects = await this.deps.modrinth.projects(missing);
      for (const id of missing) this.icons.set(id, null);
      for (const p of projects) this.icons.set(p.id, p.icon_url);
    } catch {
      // Icons are decoration; try again next time.
    }
  }

  private readSources(server: ServerInstance): Record<string, StoredSource> {
    try {
      return JSON.parse(fs.readFileSync(path.join(server.directory, SOURCES_FILE), "utf8")) as Record<string, StoredSource>;
    } catch {
      return {};
    }
  }

  private writeSources(server: ServerInstance, sources: Record<string, StoredSource>) {
    writeJson(path.join(server.directory, SOURCES_FILE), sources);
  }

  private addManualFiles(server: ServerInstance, files: ManualFile[]) {
    const file = path.join(server.directory, MANUAL_FILE);
    let list: ManualFile[] = [];
    try {
      list = JSON.parse(fs.readFileSync(file, "utf8")) as ManualFile[];
    } catch {
      // First manual file for this server.
    }
    for (const f of files) if (!list.some((x) => x.path === f.path)) list.push(f);
    writeJson(file, list);
  }

  private entryDir(server: ServerInstance, id: string) {
    return resolveInside(path.join(server.directory, HISTORY_DIR), id);
  }

  private newEntry(server: ServerInstance): StoredEntry {
    const at = new Date().toISOString();
    const id = `${at.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(this.entryDir(server, id), { recursive: true });
    return { id, at, summary: "", undone: false, added: [], removed: [], renamed: [] };
  }

  private moveToHistory(server: ServerInstance, entry: StoredEntry, file: string) {
    const from = path.join(server.directory, "mods", file);
    const stored = `${entry.removed.length}-${file}`;
    const dir = path.join(this.entryDir(server, entry.id), "removed");
    fs.mkdirSync(dir, { recursive: true });
    const sha1 = this.cachedSha1(from);
    fs.renameSync(from, path.join(dir, stored));
    entry.removed.push({ file, sha1, stored });
  }

  private saveEntry(server: ServerInstance, entry: StoredEntry) {
    this.writeEntry(server, entry);
    // Keep the newest entries; older ones and the files they kept are let go.
    for (const old of this.entries(server).slice(KEEP_HISTORY)) fs.rmSync(this.entryDir(server, old.id), { recursive: true, force: true });
  }

  private writeEntry(server: ServerInstance, entry: StoredEntry) {
    writeJson(path.join(this.entryDir(server, entry.id), "entry.json"), entry);
  }

  /** Newest first. */
  private entries(server: ServerInstance): StoredEntry[] {
    const root = path.join(server.directory, HISTORY_DIR);
    if (!fs.existsSync(root)) return [];
    const out: StoredEntry[] = [];
    for (const name of fs.readdirSync(root)) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(root, name, "entry.json"), "utf8")) as StoredEntry);
      } catch {
        // An entry whose change never finished has no entry.json; it is not shown.
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  }

  private async download(url: string, dest: string, title: string, hash: { algo: "sha1" | "sha512"; value: string } | undefined, size: number, serverId: string) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const { done } = this.deps.downloads.enqueue({ url, dest, title: toSafeName(title, "mod"), hash, size, serverId });
    const result = await done;
    if (!result.ok) throw new Error(result.cancelled ? `${title}: download cancelled` : `${title}: ${result.error}`);
  }
}

class PlanBuilder {
  readonly files: PlanDownload[] = [];
  readonly manual: ManualFile[] = [];
  readonly warnings: string[] = [];
  readonly loaders: string[];
  readonly loaderName: string;
  private readonly visited = new Set<string>();

  constructor(
    readonly server: ServerInstance,
    private readonly installed: InstalledMod[],
  ) {
    this.loaders = loadersAccepted(server.type as LoaderType);
    this.loaderName = LOADER_NAMES[server.type as LoaderType];
  }

  seen(key: string) {
    if (this.visited.has(key)) return true;
    this.visited.add(key);
    return false;
  }

  installedProject(provider: ModProvider, projectId: string) {
    return this.installed.find((m) => m.source?.provider === provider && m.source.projectId === projectId) ?? null;
  }
}

function target(server: ServerInstance) {
  return { loader: server.type as LoaderType, minecraftVersion: server.minecraftVersion, loaderVersion: server.loaderVersion };
}

/** Prefer releases, then betas, then alphas; Modrinth lists newest first. */
export function pickModrinthVersion(versions: ModrinthVersion[]): ModrinthVersion | null {
  for (const type of ["release", "beta", "alpha"] as const) {
    const v = versions.find((x) => x.version_type === type);
    if (v) return v;
  }
  return null;
}

function safeJarName(name: string) {
  const safe = toSafeName(path.basename(name), "mod.jar");
  return /\.jar$/i.test(safe) ? safe : `${safe}.jar`;
}

function baseName(file: string) {
  return file.replace(/\.disabled$/, "");
}

function sha1Of(file: string) {
  return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function names(list: string[]) {
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

function describe(parts: (string | 0 | false)[]) {
  return parts.filter(Boolean).join("; ");
}
