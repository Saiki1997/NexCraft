/** Mod manager types shared by the main process and the UI. */
import type { ManualFile } from "./modpacks";

/**
 * How sure NexCraft is that a mod works on a server, from most to least certain:
 * - confirmed: the provider lists this exact file for the server's Minecraft version and loader.
 * - metadata: the mod's own metadata says it fits.
 * - conflict: something looks wrong (missing or mismatched dependency, duplicate), but it may still load.
 * - unknown: neither the provider nor the mod says.
 * - incompatible: the mod or another installed mod says it will not work.
 */
export type CompatLabel = "confirmed" | "metadata" | "conflict" | "unknown" | "incompatible";

export type ModProvider = "modrinth" | "curseforge";

export interface ModSource {
  provider: ModProvider;
  projectId: string;
  versionId: string;
  page: string;
}

export interface InstalledMod {
  /** File name in the mods folder, including ".disabled" when switched off. */
  file: string;
  enabled: boolean;
  size: number;
  sha1: string;
  id: string | null;
  name: string;
  version: string | null;
  environment: "client" | "server" | "both" | "unknown";
  label: CompatLabel;
  /** Plain-language reasons behind the label. */
  reasons: string[];
  source: ModSource | null;
  iconUrl: string | null;
}

export interface ModList {
  mods: InstalledMod[];
  /** False when the providers could not be asked (offline); labels then rely on metadata. */
  providerChecked: boolean;
}

export interface ModUpdate {
  file: string;
  name: string;
  currentVersion: string | null;
  newVersion: string;
  provider: ModProvider;
  projectId: string;
  versionId: string;
}

/** One file a planned change will download. */
export interface PlannedFile {
  name: string;
  version: string;
  fileName: string;
  provider: ModProvider;
  projectId: string;
  versionId: string;
  reason: "requested" | "dependency" | "update";
  /** Installed file this replaces, if any. */
  replaces: string | null;
}

/** A change to a server's mods, shown to the user before it is applied. */
export interface ModChangePlan {
  id: string;
  serverId: string;
  files: PlannedFile[];
  /** Files whose authors do not allow apps to download them. */
  manual: ManualFile[];
  warnings: string[];
}

export interface ModHistoryEntry {
  id: string;
  at: string;
  summary: string;
  undone: boolean;
  /** Whether undoing is still possible (the files it touched are as it left them). */
  canUndo: boolean;
}
