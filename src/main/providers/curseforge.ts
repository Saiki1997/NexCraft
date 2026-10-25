/**
 * CurseForge API client (https://docs.curseforge.com/rest-api). Needs an API key,
 * which comes from the build (CI secret) or the user's own key in Settings. The
 * key is sent only to api.curseforge.com and never logged.
 */
import { explainNetworkError, HttpError } from "../core/http-json";

const API = "https://api.curseforge.com/v1";
export const MINECRAFT_GAME_ID = 432;
export const CLASS_MODS = 6;
export const CLASS_MODPACKS = 4471;

/** CurseForge's modLoaderType numbers. */
export const CF_LOADER: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

export interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  /** Null when the author does not allow third-party downloads. */
  downloadUrl: string | null;
  fileLength: number;
  hashes: { value: string; algo: number }[];
  gameVersions: string[];
  serverPackFileId?: number | null;
  isServerPack?: boolean;
  releaseType: 1 | 2 | 3;
  dependencies: { modId: number; relationType: number }[];
}

export interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  classId: number;
  downloadCount: number;
  allowModDistribution: boolean | null;
  logo: { thumbnailUrl: string } | null;
  links: { websiteUrl: string };
  authors: { name: string }[];
  latestFilesIndexes: { gameVersion: string; fileId: number; modLoader: number | null }[];
}

export class CurseForgeClient {
  constructor(
    private readonly getKey: () => string | null,
    private readonly userAgent: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  available() {
    return Boolean(this.getKey());
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const key = this.getKey();
    if (!key) throw new Error("CurseForge needs an API key. Add one in Settings, or use a Modrinth pack.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await (this.fetchImpl ?? fetch)(`${API}${path}`, {
        method: init.method ?? "GET",
        headers: { "x-api-key": key, accept: "application/json", "user-agent": this.userAgent, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      }).catch((err: unknown) => Promise.reject(explainNetworkError("CurseForge", err)));
      if (res.status === 403) throw new HttpError("CurseForge refused the API key. Check the key in Settings.", 403);
      if (!res.ok) throw new HttpError(`CurseForge answered ${res.status}`, res.status);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  search(opts: { query: string; classId: number; gameVersion?: string; loader?: string; index?: number; pageSize?: number }) {
    const q = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(opts.classId),
      searchFilter: opts.query,
      sortField: "2",
      sortOrder: "desc",
      pageSize: String(opts.pageSize ?? 20),
      index: String(opts.index ?? 0),
    });
    if (opts.gameVersion) q.set("gameVersion", opts.gameVersion);
    if (opts.loader && CF_LOADER[opts.loader]) q.set("modLoaderType", String(CF_LOADER[opts.loader]));
    return this.request<{ data: CfMod[]; pagination: { totalCount: number } }>(`/mods/search?${q}`);
  }

  async mod(id: number) {
    return (await this.request<{ data: CfMod }>(`/mods/${id}`)).data;
  }

  async mods(ids: number[]) {
    if (!ids.length) return [];
    return (await this.request<{ data: CfMod[] }>("/mods", { method: "POST", body: { modIds: ids } })).data;
  }

  async modBySlug(slug: string, classId: number) {
    const q = new URLSearchParams({ gameId: String(MINECRAFT_GAME_ID), classId: String(classId), slug });
    return (await this.request<{ data: CfMod[] }>(`/mods/search?${q}`)).data[0] ?? null;
  }

  async files(modId: number, filter: { gameVersion?: string; loader?: string } = {}) {
    const q = new URLSearchParams({ pageSize: "50" });
    if (filter.gameVersion) q.set("gameVersion", filter.gameVersion);
    if (filter.loader && CF_LOADER[filter.loader]) q.set("modLoaderType", String(CF_LOADER[filter.loader]));
    return (await this.request<{ data: CfFile[] }>(`/mods/${modId}/files?${q}`)).data;
  }

  async file(modId: number, fileId: number) {
    return (await this.request<{ data: CfFile }>(`/mods/${modId}/files/${fileId}`)).data;
  }

  /** Batch lookup; CurseForge accepts large batches but we keep them modest. */
  async filesById(ids: number[]): Promise<CfFile[]> {
    const out: CfFile[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      out.push(...(await this.request<{ data: CfFile[] }>("/mods/files", { method: "POST", body: { fileIds: chunk } })).data);
    }
    return out;
  }
}

export function cfSha1(file: Pick<CfFile, "hashes">): string | undefined {
  return file.hashes.find((h) => h.algo === 1)?.value?.toLowerCase();
}

/** CurseForge tags files with "Client" and "Server" among their game versions when the author says so. */
export function cfSide(file: Pick<CfFile, "gameVersions">): "client" | "server" | "both" | "unknown" {
  const client = file.gameVersions.includes("Client");
  const server = file.gameVersions.includes("Server");
  if (client && !server) return "client";
  if (server && !client) return "server";
  if (client && server) return "both";
  return "unknown";
}

/** Page where the user can download a file the author does not allow apps to download. */
export function cfFilePage(mod: Pick<CfMod, "links"> | null, file: Pick<CfFile, "id" | "modId">): string {
  const base = mod?.links.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${file.modId}`;
  return `${base.replace(/\/$/, "")}/files/${file.id}`;
}

/** "https://www.curseforge.com/minecraft/modpacks/all-the-mods-10" → "all-the-mods-10". */
export function curseforgeSlugFromInput(input: string): { slug: string; kind: "modpacks" | "mc-mods" } | null {
  const m = /^https?:\/\/(?:www\.)?curseforge\.com\/minecraft\/(modpacks|mc-mods)\/([\w-]+)/i.exec(input.trim());
  return m ? { kind: m[1].toLowerCase() as "modpacks" | "mc-mods", slug: m[2] } : null;
}
