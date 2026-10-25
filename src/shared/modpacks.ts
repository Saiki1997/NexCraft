/** Modpack import types shared by the main process and the UI. */
export type ModpackSource = "modrinth" | "curseforge" | "local";

export interface ManualFile {
  name: string;
  /** Where the file goes, relative to the server folder (e.g. mods/foo.jar). */
  path: string;
  /** Web page where the user can download it. */
  page: string;
  sha1: string | null;
}

/** What importing a pack will do, shown to the user before anything is written. */
export interface ImportSummary {
  id: string;
  name: string;
  version: string;
  source: ModpackSource;
  minecraftVersion: string;
  loader: { type: "fabric" | "quilt" | "forge" | "neoforge"; version: string } | null;
  fileCount: number;
  /** Files NexCraft will download for the server. */
  serverFileCount: number;
  /** Files the pack marks as client-only; they are not installed. */
  clientOnly: string[];
  /** Server files whose author did not say which side they run on. */
  unknownSide: number;
  /** Files whose authors do not allow apps to download them. */
  manual: ManualFile[];
  /** CurseForge's official server pack for this version, when one exists. */
  serverPack: { fileName: string; size: number } | null;
  warnings: string[];
}

export interface PackSearchHit {
  source: "modrinth" | "curseforge";
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  gameVersions: string[];
  loaders: string[];
}
