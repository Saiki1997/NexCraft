/**
 * Mojang's official version metadata (piston-meta). Used to list versions, find
 * the server JAR with its SHA-1 and size, and read the required Java version.
 */
import path from "node:path";
import { z } from "zod";
import { fetchJson } from "../core/http-json";
import { fallbackJavaMajor } from "./java-requirement";

export const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

const ManifestSchema = z.object({
  latest: z.object({ release: z.string(), snapshot: z.string() }),
  versions: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["release", "snapshot", "old_beta", "old_alpha"]),
      url: z.string().url(),
      sha1: z.string().regex(/^[0-9a-f]{40}$/),
      releaseTime: z.string(),
    }),
  ),
});
export type VersionManifest = z.infer<typeof ManifestSchema>;

const VersionJsonSchema = z.object({
  id: z.string(),
  javaVersion: z.object({ majorVersion: z.number().int().positive() }).optional(),
  downloads: z.object({
    server: z.object({ sha1: z.string().regex(/^[0-9a-f]{40}$/), size: z.number().int().positive(), url: z.string().url() }).optional(),
  }),
});

export interface MinecraftVersion {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;
}

export interface ServerDownload {
  versionId: string;
  url: string;
  sha1: string;
  size: number;
  javaMajor: number;
  javaFromManifest: boolean;
}

export class MojangClient {
  constructor(
    private readonly cacheDir: string,
    private readonly userAgent: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async manifest(): Promise<{ manifest: VersionManifest; fromCache: boolean }> {
    const { data, fromCache } = await fetchJson(MANIFEST_URL, {
      userAgent: this.userAgent,
      fetch: this.fetchImpl,
      cacheFile: path.join(this.cacheDir, "mojang", "version_manifest_v2.json"),
      cacheTtlMs: 30 * 60_000,
    });
    return { manifest: ManifestSchema.parse(data), fromCache };
  }

  async versions(includeSnapshots = false): Promise<{ versions: MinecraftVersion[]; latest: string; fromCache: boolean }> {
    const { manifest, fromCache } = await this.manifest();
    const versions = manifest.versions
      .filter((v) => v.type === "release" || (includeSnapshots && v.type === "snapshot"))
      .map(({ id, type, releaseTime }) => ({ id, type, releaseTime }));
    return { versions, latest: manifest.latest.release, fromCache };
  }

  async serverDownload(versionId: string): Promise<ServerDownload> {
    const { manifest } = await this.manifest();
    const entry = manifest.versions.find((v) => v.id === versionId);
    if (!entry) throw new Error(`Minecraft ${versionId} is not in Mojang's version list`);
    const { data } = await fetchJson(entry.url, {
      userAgent: this.userAgent,
      fetch: this.fetchImpl,
      sha1: entry.sha1,
      // Version JSON is immutable for a given SHA-1, so the cache never expires.
      cacheFile: path.join(this.cacheDir, "mojang", "versions", `${entry.sha1}.json`),
      cacheTtlMs: Number.MAX_SAFE_INTEGER,
    });
    const json = VersionJsonSchema.parse(data);
    if (!json.downloads.server) throw new Error(`Mojang does not publish a dedicated server for Minecraft ${versionId}`);
    return {
      versionId,
      url: json.downloads.server.url,
      sha1: json.downloads.server.sha1,
      size: json.downloads.server.size,
      javaMajor: json.javaVersion?.majorVersion ?? fallbackJavaMajor(versionId),
      javaFromManifest: Boolean(json.javaVersion),
    };
  }
}
