/**
 * Read what a mod jar says about itself: id, name, version, which loader it is
 * for, whether it runs on servers, and which Minecraft versions and other mods it
 * needs. Covers Fabric, Quilt, Forge and NeoForge metadata files.
 */
import { parse as parseToml } from "smol-toml";
import { readZipEntries } from "../core/archive";
import { compareVersions } from "../loaders/loaders";

export type ModLoaderKind = "fabric" | "quilt" | "forge" | "neoforge";

export interface ModDependency {
  id: string;
  /** Version requirement as written by the mod author, or "*" */
  range: string;
  kind: "required" | "optional" | "incompatible";
}

export interface ModMetadata {
  id: string;
  name: string;
  version: string;
  loaders: ModLoaderKind[];
  /** Where the mod says it runs. "unknown" when it does not say. */
  environment: "client" | "server" | "both" | "unknown";
  dependencies: ModDependency[];
  /** Other mod ids this jar satisfies: declared aliases and mods bundled inside it (jar-in-jar). */
  provides: string[];
}

const FILES = ["fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "mcmod.info", "META-INF/MANIFEST.MF", "META-INF/jarjar/metadata.json"];
const MAX_NESTED_JARS = 64;
const MAX_NESTED_BYTES = 16 * 1024 * 1024;

/** Returns null for jars that carry no recognisable mod metadata (libraries, plugins). */
export async function readModMetadata(jar: string | Buffer): Promise<ModMetadata | null> {
  return readFrom(jar, true);
}

async function readFrom(jar: string | Buffer, withNested: boolean): Promise<ModMetadata | null> {
  const entries = await readZipEntries(jar, FILES, 1024 * 1024);
  const text = (name: string) => entries.get(name)?.toString("utf8").replace(/^﻿/, "");
  const manifestVersion = /^Implementation-Version:\s*(.+)$/m.exec(text("META-INF/MANIFEST.MF") ?? "")?.[1]?.trim();

  const found: ModMetadata[] = [];
  const fabric = text("fabric.mod.json");
  if (fabric) found.push(fromFabric(JSON.parse(stripJsonComments(fabric))));
  const quilt = text("quilt.mod.json");
  if (quilt) found.push(fromQuilt(JSON.parse(stripJsonComments(quilt))));
  for (const [file, loader] of [
    ["META-INF/neoforge.mods.toml", "neoforge"],
    ["META-INF/mods.toml", "forge"],
  ] as const) {
    const toml = text(file);
    if (toml) {
      const m = fromModsToml(parseToml(toml) as Record<string, unknown>, loader, manifestVersion);
      if (m) found.push(m);
    }
  }
  const legacy = text("mcmod.info");
  if (!found.length && legacy) {
    const info = JSON.parse(legacy) as unknown;
    const first = (Array.isArray(info) ? info[0] : (info as { modList?: unknown[] }).modList?.[0]) as Record<string, unknown> | undefined;
    if (first?.modid) {
      found.push({
        id: String(first.modid),
        name: String(first.name ?? first.modid),
        version: String(first.version ?? ""),
        loaders: ["forge"],
        environment: "unknown",
        dependencies: first.mcversion ? [{ id: "minecraft", range: String(first.mcversion), kind: "required" }] : [],
        provides: [],
      });
    }
  }
  if (!found.length) return null;
  // Multi-loader jars carry several files: merge the loaders, keep the first description.
  const provides = new Set(found.flatMap((f) => f.provides));
  if (withNested) {
    for (const nested of await readNested(jar, nestedJarPaths(text))) {
      provides.add(nested.id);
      for (const p of nested.provides) provides.add(p);
    }
  }
  provides.delete(found[0].id);
  return { ...found[0], loaders: [...new Set(found.flatMap((f) => f.loaders))], provides: [...provides] };
}

/** Jars bundled inside a mod, as listed by Fabric/Quilt ("jars") or Forge/NeoForge's jarjar metadata. */
function nestedJarPaths(text: (name: string) => string | undefined): string[] {
  const paths: string[] = [];
  const safeJson = (s: string | undefined) => {
    try {
      return s ? (JSON.parse(stripJsonComments(s)) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const fabric = safeJson(text("fabric.mod.json"));
  for (const j of Array.isArray(fabric?.jars) ? fabric.jars : []) if (j && typeof (j as { file?: unknown }).file === "string") paths.push((j as { file: string }).file);
  const quilt = (safeJson(text("quilt.mod.json"))?.quilt_loader ?? {}) as Record<string, unknown>;
  for (const j of Array.isArray(quilt.jars) ? quilt.jars : []) if (typeof j === "string") paths.push(j);
  const jarjar = safeJson(text("META-INF/jarjar/metadata.json"));
  for (const j of Array.isArray(jarjar?.jars) ? jarjar.jars : []) if (j && typeof (j as { path?: unknown }).path === "string") paths.push((j as { path: string }).path);
  return [...new Set(paths.map((p) => p.replace(/^\/+/, "")))].slice(0, MAX_NESTED_JARS);
}

async function readNested(jar: string | Buffer, paths: string[]): Promise<ModMetadata[]> {
  if (!paths.length) return [];
  const blobs = await readZipEntries(jar, paths, MAX_NESTED_BYTES);
  const out: ModMetadata[] = [];
  for (const blob of blobs.values()) {
    // One level deep is enough to find what a jar provides; a broken nested jar is not the outer mod's problem.
    const meta = await readFrom(blob, false).catch(() => null);
    if (meta) out.push(meta);
  }
  return out;
}

function fromFabric(j: Record<string, unknown>): ModMetadata {
  const env = j.environment;
  const deps: ModDependency[] = [];
  const add = (obj: unknown, kind: ModDependency["kind"]) => {
    if (!obj || typeof obj !== "object") return;
    for (const [id, range] of Object.entries(obj as Record<string, unknown>)) deps.push({ id: normaliseId(id), range: Array.isArray(range) ? range.join(" || ") : String(range), kind });
  };
  add(j.depends, "required");
  add(j.recommends, "optional");
  add(j.suggests, "optional");
  add(j.breaks, "incompatible");
  return {
    id: String(j.id ?? "unknown"),
    name: String(j.name ?? j.id ?? "Unknown mod"),
    version: String(j.version ?? ""),
    loaders: ["fabric", "quilt"],
    // Fabric's default environment is "*": both sides.
    environment: env === "client" ? "client" : env === "server" ? "server" : env === "*" || env === undefined ? "both" : "unknown",
    dependencies: deps,
    provides: Array.isArray(j.provides) ? j.provides.map((p) => normaliseId(String(p))) : [],
  };
}

function fromQuilt(j: Record<string, unknown>): ModMetadata {
  const ql = (j.quilt_loader ?? {}) as Record<string, unknown>;
  const meta = (ql.metadata ?? {}) as Record<string, unknown>;
  const env = ((j.minecraft ?? {}) as Record<string, unknown>).environment;
  const deps: ModDependency[] = [];
  const add = (list: unknown, kind: ModDependency["kind"]) => {
    if (!Array.isArray(list)) return;
    for (const d of list) {
      if (typeof d === "string") deps.push({ id: normaliseId(d), range: "*", kind });
      else if (d && typeof d === "object") {
        const o = d as Record<string, unknown>;
        const versions = Array.isArray(o.versions) ? o.versions.join(" || ") : (o.versions as string | undefined) ?? "*";
        deps.push({ id: normaliseId(String(o.id)), range: String(versions), kind: o.optional ? "optional" : kind });
      }
    }
  };
  add(ql.depends, "required");
  add(ql.breaks, "incompatible");
  return {
    id: String(ql.id ?? "unknown"),
    name: String(meta.name ?? ql.id ?? "Unknown mod"),
    version: String(ql.version ?? ""),
    loaders: ["quilt"],
    environment: env === "client" ? "client" : env === "dedicated_server" ? "server" : env === "*" ? "both" : "unknown",
    dependencies: deps,
    provides: Array.isArray(ql.provides) ? ql.provides.map((p) => normaliseId(typeof p === "string" ? p : String((p as { id?: unknown }).id ?? ""))).filter(Boolean) : [],
  };
}

function fromModsToml(t: Record<string, unknown>, loader: "forge" | "neoforge", manifestVersion?: string): ModMetadata | null {
  const mods = Array.isArray(t.mods) ? (t.mods as Record<string, unknown>[]) : [];
  const mod = mods[0];
  if (!mod?.modId) return null;
  const id = String(mod.modId);
  let version = String(mod.version ?? "");
  if (version.includes("${file.jarVersion}")) version = manifestVersion ?? "";
  const depTable = ((t.dependencies ?? {}) as Record<string, unknown>)[id];
  const deps: ModDependency[] = [];
  let clientOnlyHint = t.clientSideOnly === true;
  for (const d of Array.isArray(depTable) ? (depTable as Record<string, unknown>[]) : []) {
    const type = typeof d.type === "string" ? d.type.toLowerCase() : d.mandatory === false ? "optional" : "required";
    const kind: ModDependency["kind"] = type === "required" ? "required" : type === "incompatible" ? "incompatible" : "optional";
    const depId = normaliseId(String(d.modId ?? ""));
    if (!depId) continue;
    deps.push({ id: depId, range: String(d.versionRange ?? "*"), kind });
    if (depId === "minecraft" && String(d.side ?? "").toUpperCase() === "CLIENT") clientOnlyHint = true;
  }
  return {
    id,
    name: String(mod.displayName ?? id),
    version,
    loaders: [loader],
    environment: clientOnlyHint ? "client" : "unknown",
    dependencies: deps,
    provides: mods.slice(1).map((m) => normaliseId(String(m.modId ?? ""))).filter(Boolean),
  };
}

function normaliseId(id: string) {
  const lower = id.trim().toLowerCase();
  if (lower === "fabricloader" || lower === "quilt_loader") return "loader";
  return lower;
}

function stripJsonComments(s: string) {
  // Some mods ship fabric.mod.json with stray control characters or trailing commas.
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/,\s*([}\]])/g, "$1");
}

/**
 * Does `version` satisfy `range`? Understands Fabric/semver-style ranges
 * (">=1.21", "~1.20.4", "1.21.x", "a || b", space-separated "and") and Maven
 * ranges used by Forge ("[1.21,1.22)", "[1.20.1]"). Returns null when the range
 * is written in a way it does not understand.
 */
export function versionMatches(range: string, version: string): boolean | null {
  const r = range.trim();
  if (!r || r === "*") return true;
  if (/^[[(]/.test(r)) return mavenMatches(r, version);
  const alternatives = r.split("||").map((a) => a.trim());
  let unknown = false;
  for (const alt of alternatives) {
    const parts = alt.split(/\s+/).filter(Boolean);
    let ok: boolean | null = true;
    for (const p of parts) {
      const res = singleMatches(p, version);
      if (res === null) ok = ok === false ? false : null;
      else if (!res) ok = false;
    }
    if (ok === true) return true;
    if (ok === null) unknown = true;
  }
  return unknown ? null : false;
}

function singleMatches(p: string, v: string): boolean | null {
  const m = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(p);
  if (!m) return null;
  const [, op = "", target] = m;
  if (/^[\d.]+(\.x|\.\*)$/.test(target) || /^[\d.]+$/.test(target) || /^[\d.]+-[\w.]+$/.test(target)) {
    const base = target.replace(/\.(x|\*)$/, "");
    const cmp = compareVersions(v, base);
    switch (op) {
      case ">=":
        return cmp >= 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case "<":
        return cmp < 0;
      case "~": {
        const segs = base.split(".");
        const upper = segs.length >= 2 ? `${segs[0]}.${Number(segs[1]) + 1}` : String(Number(segs[0]) + 1);
        return cmp >= 0 && compareVersions(v, upper) < 0;
      }
      case "^": {
        const segs = base.split(".");
        const upper = segs[0] === "1" && segs.length > 1 ? `1.${Number(segs[1]) + 1}` : String(Number(segs[0]) + 1);
        return cmp >= 0 && compareVersions(v, upper) < 0;
      }
      default:
        if (/\.(x|\*)$/.test(target)) return v === base || v.startsWith(`${base}.`);
        return cmp === 0;
    }
  }
  return null;
}

function mavenMatches(range: string, v: string): boolean | null {
  // A Maven range may be a union: "[1.20,1.20.1],[1.21,)"
  const sets = range.match(/[[(][^\])]*[\])]/g);
  if (!sets) return null;
  return sets.some((set) => {
    const lowInc = set.startsWith("[");
    const highInc = set.endsWith("]");
    const inner = set.slice(1, -1);
    if (!inner.includes(",")) return compareVersions(v, inner.trim()) === 0;
    const [low, high] = inner.split(",").map((s) => s.trim());
    if (low && (lowInc ? compareVersions(v, low) < 0 : compareVersions(v, low) <= 0)) return false;
    if (high && (highInc ? compareVersions(v, high) > 0 : compareVersions(v, high) >= 0)) return false;
    return true;
  });
}
