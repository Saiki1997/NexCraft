/**
 * Decide how sure NexCraft is that each mod works on a server, and say why in
 * plain words. Pure logic: callers gather the jar metadata and provider facts.
 */
import type { CompatLabel } from "../../shared/mods";
import { LOADER_NAMES, type LoaderType } from "../loaders/loaders";
import { versionMatches, type ModMetadata } from "./mod-metadata";

export interface ServerTarget {
  loader: LoaderType;
  minecraftVersion: string;
  loaderVersion: string | null;
}

export interface ModFacts {
  file: string;
  enabled: boolean;
  meta: ModMetadata | null;
  /** What the provider says about this exact file, when it recognised it. */
  provider: { name: string; gameVersions: string[]; loaders: string[] } | null;
}

export interface Assessment {
  label: CompatLabel;
  reasons: string[];
}

/** Dependencies the server itself satisfies, or that NexCraft cannot check. */
const PLATFORM_IDS = new Set(["minecraft", "java", "loader", "forge", "neoforge", "fml", "javafml"]);

/** Loaders whose mods a server type can run. Quilt runs most Fabric mods. */
export function loadersAccepted(loader: LoaderType): string[] {
  return loader === "quilt" ? ["quilt", "fabric"] : [loader];
}

export function assessMods(target: ServerTarget, mods: ModFacts[]): Assessment[] {
  const enabled = mods.filter((m) => m.enabled && m.meta);
  const providers = (pool: ModFacts[], id: string) =>
    pool.filter((m) => m.meta && (m.meta.id === id || m.meta.provides.includes(id) || (id === "fabric" && m.meta.id === "fabric-api") || (id === "fabric-api" && m.meta.provides.includes("fabric"))));
  const accepted = loadersAccepted(target.loader);
  const loaderName = LOADER_NAMES[target.loader];

  return mods.map((mod) => {
    const bad: string[] = [];
    const doubt: string[] = [];
    const notes: string[] = [];
    const meta = mod.meta;

    let providerOk = false;
    if (mod.provider) {
      const p = mod.provider;
      const loaderOk = p.loaders.some((l) => accepted.includes(l));
      const gameOk = p.gameVersions.includes(target.minecraftVersion);
      if (!loaderOk && p.loaders.length) bad.push(`${p.name} lists this file for ${listLoaders(p.loaders)}, not ${loaderName}.`);
      else if (!gameOk) {
        const mcRange = meta?.dependencies.find((d) => d.id === "minecraft" && d.kind === "required")?.range;
        const metaSays = mcRange ? versionMatches(mcRange, target.minecraftVersion) : null;
        if (metaSays === true) notes.push(`${p.name} does not list Minecraft ${target.minecraftVersion} for this file, but the mod itself says it supports it.`);
        else if (metaSays === null) doubt.push(`${p.name} lists this file for Minecraft ${shortList(p.gameVersions)}, not ${target.minecraftVersion}.`);
      } else providerOk = true;
    }

    if (meta) {
      if (meta.environment === "client") bad.push("Made for the game client only. It does nothing on a server and can stop it from starting.");
      if (meta.loaders.length && !meta.loaders.some((l) => accepted.includes(l))) bad.push(`This is a ${listLoaders(meta.loaders)} mod; this server runs ${loaderName}.`);

      for (const dep of meta.dependencies) {
        if (dep.kind === "optional") continue;
        if (dep.id === "minecraft") {
          if (dep.kind === "required" && versionMatches(dep.range, target.minecraftVersion) === false) bad.push(`Needs Minecraft ${dep.range}; this server runs ${target.minecraftVersion}.`);
          continue;
        }
        if (isLoaderDep(dep.id, target.loader)) {
          if (dep.kind === "required" && target.loaderVersion && versionMatches(dep.range, target.loaderVersion) === false) bad.push(`Needs ${loaderName} ${dep.range}; this server has ${target.loaderVersion}.`);
          continue;
        }
        if (PLATFORM_IDS.has(dep.id)) continue;

        const found = providers(enabled, dep.id).filter((m) => m !== mod);
        if (dep.kind === "incompatible") {
          const clash = found.find((m) => versionMatches(dep.range, m.meta!.version) !== false);
          if (clash) bad.push(`Does not work together with ${clash.meta!.name}.`);
          continue;
        }
        if (!found.length) {
          const off = providers(mods.filter((m) => !m.enabled), dep.id)[0];
          doubt.push(off ? `Needs ${off.meta!.name}, which is switched off.` : `Needs ${dep.id}, which is not installed.`);
          continue;
        }
        // Only check versions against a mod that is itself that id; bundled copies rarely carry a usable version.
        const direct = found.find((m) => m.meta!.id === dep.id);
        if (direct && direct.meta!.version && versionMatches(dep.range, direct.meta!.version) === false) {
          doubt.push(`Needs ${direct.meta!.name} ${dep.range}; version ${direct.meta!.version} is installed.`);
        }
      }

      if (mod.enabled) {
        for (const other of enabled) {
          if (other === mod) continue;
          if (other.meta!.id === meta.id) doubt.push(`Installed twice; ${other.file} is the same mod.`);
          const dep = other.meta!.dependencies.find((d) => d.kind === "incompatible" && d.id === meta.id);
          if (dep && versionMatches(dep.range, meta.version) !== false) bad.push(`${other.meta!.name} says it does not work with this mod.`);
        }
      }
    }

    const reasons = [...new Set([...bad, ...doubt, ...notes])];
    if (bad.length) return { label: "incompatible", reasons };
    if (doubt.length) return { label: "conflict", reasons };
    if (providerOk) return { label: "confirmed", reasons: reasons.length ? reasons : [`${mod.provider!.name} lists this file for Minecraft ${target.minecraftVersion} on ${loaderName}.`] };
    if (meta) {
      const mc = meta.dependencies.some((d) => d.id === "minecraft");
      return { label: "metadata", reasons: [...reasons, mc ? "The mod's own metadata says it fits this server." : "The mod fits this loader but does not say which Minecraft versions it supports."] };
    }
    return { label: "unknown", reasons: [...reasons, "This jar has no mod metadata and no provider recognised it."] };
  });
}

function isLoaderDep(id: string, loader: LoaderType) {
  if (id === "loader") return loader === "fabric" || loader === "quilt";
  return id === loader;
}

function listLoaders(loaders: string[]) {
  const names = loaders.map((l) => (l in LOADER_NAMES ? LOADER_NAMES[l as LoaderType] : l));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? "another loader");
}

function shortList(versions: string[]) {
  const v = versions.filter((x) => !/^(Client|Server)$/.test(x));
  return v.length > 4 ? `${v.slice(0, 2).join(", ")} … ${v.at(-1)}` : v.join(", ");
}
