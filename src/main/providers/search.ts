/**
 * Provider-neutral search and version listing for modpacks, so the UI can treat
 * Modrinth and CurseForge the same way.
 */
import type { PackSearchHit } from "../../shared/modpacks";
import { CF_LOADER, CLASS_MODPACKS, curseforgeSlugFromInput, type CurseForgeClient } from "./curseforge";
import { modrinthSlugFromInput, type ModrinthClient } from "./modrinth";

const LOADER_BY_CF = Object.fromEntries(Object.entries(CF_LOADER).map(([k, v]) => [v, k]));

export async function searchModpacks(
  modrinth: ModrinthClient,
  curseforge: CurseForgeClient,
  opts: { source: "modrinth" | "curseforge"; query: string; gameVersion?: string; loader?: string },
): Promise<PackSearchHit[]> {
  if (opts.source === "modrinth") {
    const r = await modrinth.search({ query: opts.query, projectType: "modpack", gameVersion: opts.gameVersion, loader: opts.loader });
    return r.hits.map((h) => ({
      source: "modrinth",
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      iconUrl: h.icon_url,
      gameVersions: h.versions.slice(-5).reverse(),
      loaders: h.categories.filter((c) => ["fabric", "quilt", "forge", "neoforge"].includes(c)),
    }));
  }
  const r = await curseforge.search({ query: opts.query, classId: CLASS_MODPACKS, gameVersion: opts.gameVersion, loader: opts.loader });
  return r.data.map((m) => ({
    source: "curseforge",
    id: String(m.id),
    slug: m.slug,
    title: m.name,
    description: m.summary,
    author: m.authors[0]?.name ?? "",
    downloads: m.downloadCount,
    iconUrl: m.logo?.thumbnailUrl ?? null,
    gameVersions: [...new Set(m.latestFilesIndexes.map((i) => i.gameVersion))].slice(0, 5),
    loaders: [...new Set(m.latestFilesIndexes.map((i) => (i.modLoader != null ? LOADER_BY_CF[i.modLoader] : undefined)).filter((l): l is string => Boolean(l)))],
  }));
}

export async function modpackVersions(modrinth: ModrinthClient, curseforge: CurseForgeClient, source: "modrinth" | "curseforge", projectId: string) {
  if (source === "modrinth") {
    return (await modrinth.versions(projectId)).map((v) => ({
      id: v.id,
      name: v.version_number || v.name,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      date: v.date_published,
      stable: v.version_type === "release",
    }));
  }
  return (await curseforge.files(Number(projectId)))
    .filter((f) => !f.isServerPack)
    .map((f) => ({
      id: String(f.id),
      name: f.displayName,
      gameVersions: f.gameVersions.filter((g) => /^\d/.test(g)),
      loaders: f.gameVersions.map((g) => g.toLowerCase()).filter((g) => ["fabric", "quilt", "forge", "neoforge"].includes(g)),
      date: f.fileDate,
      stable: f.releaseType === 1,
    }));
}

/** Resolve a pasted link to a provider project. */
export async function resolvePackLink(
  modrinth: ModrinthClient,
  curseforge: CurseForgeClient,
  link: string,
): Promise<{ source: "modrinth" | "curseforge"; projectId: string } | null> {
  const cf = curseforgeSlugFromInput(link);
  if (cf) {
    const mod = await curseforge.modBySlug(cf.slug, CLASS_MODPACKS);
    if (!mod) throw new Error(`CurseForge has no modpack called "${cf.slug}"`);
    return { source: "curseforge", projectId: String(mod.id) };
  }
  if (/curseforge\.com/i.test(link)) throw new Error("That CurseForge link is not a modpack page");
  const slug = modrinthSlugFromInput(link);
  if (slug) {
    const p = await modrinth.project(slug);
    return { source: "modrinth", projectId: p.id };
  }
  return null;
}
