/**
 * Eclipse Temurin (Adoptium) JRE builds. The Adoptium API returns the package
 * link, size and SHA-256 checksum, and NexCraft verifies the download against them.
 */
import { z } from "zod";
import { fetchJson } from "../core/http-json";

const AssetSchema = z.array(
  z.object({
    binary: z.object({
      architecture: z.string(),
      image_type: z.string(),
      os: z.string(),
      package: z.object({
        name: z.string(),
        link: z.string().url(),
        checksum: z.string().regex(/^[0-9a-f]{64}$/i),
        size: z.number().int().positive(),
      }),
    }),
    release_name: z.string(),
    version: z.object({ semver: z.string() }).passthrough(),
  }),
);

export interface JrePackage {
  major: number;
  releaseName: string;
  version: string;
  fileName: string;
  url: string;
  sha256: string;
  size: number;
}

export function adoptiumUrl(major: number, os: "windows" | "linux" | "mac", arch: "x64" | "aarch64") {
  return `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`;
}

export async function latestJre(major: number, opts: { userAgent: string; fetch?: typeof fetch; os?: "windows" | "linux" | "mac"; arch?: "x64" | "aarch64" }): Promise<JrePackage> {
  const os = opts.os ?? "windows";
  const { data } = await fetchJson(adoptiumUrl(major, os, opts.arch ?? "x64"), { userAgent: opts.userAgent, fetch: opts.fetch });
  const assets = AssetSchema.parse(data);
  const wantExt = os === "windows" ? ".zip" : ".tar.gz";
  const asset = assets.find((a) => a.binary.image_type === "jre" && a.binary.package.name.endsWith(wantExt));
  if (!asset) throw new Error(`Adoptium has no Java ${major} JRE for ${os}`);
  return {
    major,
    releaseName: asset.release_name,
    version: asset.version.semver,
    fileName: asset.binary.package.name,
    url: asset.binary.package.link,
    sha256: asset.binary.package.checksum.toLowerCase(),
    size: asset.binary.package.size,
  };
}
