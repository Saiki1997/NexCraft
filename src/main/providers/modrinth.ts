/**
 * Modrinth API client (https://docs.modrinth.com). No key is needed; requests
 * carry NexCraft's User-Agent as Modrinth asks.
 */
import { explainNetworkError, fetchJson, HttpError } from "../core/http-json";

const API = "https://api.modrinth.com/v2";

/** Hosts a Modrinth pack may download from, per the .mrpack specification. */
export const MRPACK_ALLOWED_HOSTS = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];

export interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  author: string;
  categories: string[];
  versions: string[];
  client_side: string;
  server_side: string;
}

export interface ModrinthFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  hashes: { sha1?: string; sha512?: string };
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  game_versions: string[];
  loaders: string[];
  date_published: string;
  files: ModrinthFile[];
  dependencies: { project_id: string | null; version_id: string | null; file_name: string | null; dependency_type: "required" | "optional" | "incompatible" | "embedded" }[];
}

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  project_type: string;
  client_side: string;
  server_side: string;
  icon_url: string | null;
}

export class ModrinthClient {
  constructor(
    private readonly userAgent: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  private get<T>(pathAndQuery: string) {
    return fetchJson<T>(`${API}${pathAndQuery}`, { userAgent: this.userAgent, fetch: this.fetchImpl }).then(
      (r) => r.data,
      (err) => Promise.reject(explainNetworkError("Modrinth", err)),
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await (this.fetchImpl ?? fetch)(`${API}${path}`, {
      method: "POST",
      headers: { "user-agent": this.userAgent, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((err: unknown) => Promise.reject(explainNetworkError("Modrinth", err)));
    if (!res.ok) throw new HttpError(`Modrinth answered ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  /** `loaders` match any of them, e.g. ["quilt", "fabric"] for a Quilt server. */
  search(opts: { query: string; projectType: "modpack" | "mod"; gameVersion?: string; loaders?: string[]; serverOnly?: boolean; offset?: number; limit?: number }) {
    const facets: string[][] = [[`project_type:${opts.projectType}`]];
    if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`]);
    if (opts.loaders?.length) facets.push(opts.loaders.map((l) => `categories:${l}`));
    if (opts.serverOnly) facets.push(["server_side:required", "server_side:optional"]);
    const q = new URLSearchParams({
      query: opts.query,
      facets: JSON.stringify(facets),
      limit: String(opts.limit ?? 20),
      offset: String(opts.offset ?? 0),
      index: opts.query ? "relevance" : "downloads",
    });
    return this.get<{ hits: ModrinthHit[]; total_hits: number }>(`/search?${q}`);
  }

  project(idOrSlug: string) {
    return this.get<ModrinthProject>(`/project/${encodeURIComponent(idOrSlug)}`);
  }

  projects(ids: string[]) {
    if (!ids.length) return Promise.resolve([] as ModrinthProject[]);
    return this.get<ModrinthProject[]>(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
  }

  versions(projectId: string, filter: { loaders?: string[]; gameVersions?: string[] } = {}) {
    const q = new URLSearchParams();
    if (filter.loaders) q.set("loaders", JSON.stringify(filter.loaders));
    if (filter.gameVersions) q.set("game_versions", JSON.stringify(filter.gameVersions));
    const qs = q.toString();
    return this.get<ModrinthVersion[]>(`/project/${encodeURIComponent(projectId)}/version${qs ? `?${qs}` : ""}`);
  }

  version(id: string) {
    return this.get<ModrinthVersion>(`/version/${encodeURIComponent(id)}`);
  }

  /** Identify installed files by their SHA-1. */
  versionsByHash(sha1s: string[]): Promise<Record<string, ModrinthVersion>> {
    if (!sha1s.length) return Promise.resolve({});
    return this.post("/version_files", { hashes: sha1s, algorithm: "sha1" });
  }

  /** Newest compatible version for each installed file, keyed by its SHA-1. */
  updatesByHash(sha1s: string[], loaders: string[], gameVersions: string[]): Promise<Record<string, ModrinthVersion>> {
    if (!sha1s.length) return Promise.resolve({});
    return this.post("/version_files/update", { hashes: sha1s, algorithm: "sha1", loaders, game_versions: gameVersions });
  }
}

/**
 * Turn a Modrinth link or slug into a project slug: "https://modrinth.com/modpack/fabulously-optimized"
 * → "fabulously-optimized". Returns null for anything else.
 */
export function modrinthSlugFromInput(input: string): string | null {
  const t = input.trim();
  const m = /^https?:\/\/(?:www\.)?modrinth\.com\/(?:modpack|mod|project)\/([\w.-]+)/i.exec(t);
  if (m) return m[1];
  return /^[\w.-]{2,64}$/.test(t) ? t : null;
}

export function isAllowedMrpackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && MRPACK_ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}
