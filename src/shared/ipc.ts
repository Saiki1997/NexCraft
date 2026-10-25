/**
 * The complete IPC surface between the renderer and the main process.
 *
 * Every channel has a zod schema for its input, and the main process rejects any
 * call whose input does not match. The renderer can only call the channels listed
 * here; there is deliberately no channel that runs a command, spawns an arbitrary
 * executable, or reads/writes an arbitrary path.
 */
import { z } from "zod";
import type { JavaRuntime, Job, ServerInstance, Settings } from "./model";
import { ThemeSchema } from "./model";
import type { ImportSummary, ManualFile, PackSearchHit } from "./modpacks";
import type { BackupInfo, RestorePreview } from "./backups";
import type { ModChangePlan, ModHistoryEntry, ModList, ModUpdate } from "./mods";
import { CreateServerInputSchema, ResourcesPatchSchema, type ConsoleLine, type InstallProgress, type ServerStatus } from "./servers";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  portable: boolean;
  dataDir: string;
  logsDir: string;
  totalMemoryMb: number;
  cpuCount: number;
  curseforgeKey: "override" | "built-in" | "none";
  /** Set when the stored state was unreadable and NexCraft started from defaults. */
  recoveredFrom: string | null;
}

/** Settings as the renderer sees them: secrets are reduced to "is one set". */
export type SettingsView = Omit<Settings, "curseforgeKeyOverride"> & { hasCurseforgeKeyOverride: boolean };

/** An absolute folder path (Windows drive or UNC, or POSIX for dev), or "" for the default. */
const FolderSetting = z
  .string()
  .max(1024)
  .refine((v) => v === "" || /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith("\\\\") || v.startsWith("/"), "Must be an absolute folder path");

// Written out without defaults on purpose: a patch must only contain the fields
// the user changed, or saving one setting would reset the others.
export const SettingsPatchSchema = z
  .object({
    theme: ThemeSchema,
    serversDir: FolderSetting,
    javaDir: FolderSetting,
    backupsDir: FolderSetting,
    maxParallelDownloads: z.number().int().min(1).max(8),
    onQuit: z.enum(["ask", "stop-servers"]),
    lastSelectedServerId: z.string().max(128).nullable(),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

const Empty = z.object({}).strict();
const Id = z.object({ id: z.string().min(1).max(128) }).strict();
const BackupRef = z.object({ id: z.string().min(1).max(128), backupId: z.string().min(1).max(200).regex(/^[\w.-]+$/) }).strict();
const Provider = z.enum(["modrinth", "curseforge"]);
/** A file name in a server's mods folder; the main process checks it again against the folder. */
const ModFile = z.string().min(1).max(255).regex(/^[^/\\]+\.jar(\.disabled)?$/i);

export interface MinecraftVersionList {
  versions: { id: string; type: "release" | "snapshot" | "old_beta" | "old_alpha"; releaseTime: string }[];
  latest: string;
  /** True when Mojang could not be reached and a saved copy was used. */
  fromCache: boolean;
}

/** An editable server.properties field, described as plain data for the UI. */
export interface PropertyField {
  key: string;
  label: string;
  group: string;
  kind: { type: "bool" } | { type: "int"; min: number; max: number } | { type: "enum"; options: string[] } | { type: "text"; max: number } | { type: "folder-name" };
  defaultValue: string;
  help: string;
}

export const channels = {
  "app:info": Empty,
  "settings:get": Empty,
  "settings:update": SettingsPatchSchema,
  "settings:set-curseforge-key": z.object({ key: z.string().trim().max(200).nullable() }).strict(),
  "servers:list": Empty,
  "servers:statuses": Empty,
  "servers:create": z.object({ input: CreateServerInputSchema, progressKey: z.string().min(1).max(64) }).strict(),
  "servers:remove": Id,
  "servers:accept-eula": z.object({ id: z.string().min(1).max(128), accepted: z.literal(true) }).strict(),
  "servers:start": Id,
  "servers:stop": Id,
  "servers:force-stop": z.object({ id: z.string().min(1).max(128), confirmed: z.literal(true) }).strict(),
  "servers:restart": Id,
  "servers:send-command": z.object({ id: z.string().min(1).max(128), command: z.string().max(1000) }).strict(),
  "servers:console": Id,
  "servers:get-properties": Id,
  "servers:update-properties": z.object({ id: z.string().min(1).max(128), values: z.record(z.string().max(80), z.string().max(1000)) }).strict(),
  "servers:update-resources": z.object({ id: z.string().min(1).max(128), patch: ResourcesPatchSchema }).strict(),
  "servers:open-folder": Id,
  "minecraft:versions": z.object({ includeSnapshots: z.boolean() }).strict(),
  "loaders:versions": z
    .object({ type: z.enum(["fabric", "quilt", "forge", "neoforge"]), minecraftVersion: z.string().min(1).max(32).regex(/^[\w.\-]+$/) })
    .strict(),
  "modpacks:search": z
    .object({ source: z.enum(["modrinth", "curseforge"]), query: z.string().max(100), gameVersion: z.string().max(32).optional(), loader: z.enum(["fabric", "quilt", "forge", "neoforge"]).optional() })
    .strict(),
  "modpacks:versions": z.object({ source: z.enum(["modrinth", "curseforge"]), projectId: z.string().min(1).max(64) }).strict(),
  "modpacks:inspect": z.union([
    z.object({ source: z.enum(["modrinth", "curseforge"]), projectId: z.string().min(1).max(64), versionId: z.string().max(64).nullable() }).strict(),
    z.object({ source: z.literal("file") }).strict(),
    z.object({ source: z.literal("link"), link: z.string().max(300) }).strict(),
  ]),
  "modpacks:install": z
    .object({
      planId: z.string().uuid(),
      progressKey: z.string().min(1).max(64),
      name: z.string().trim().min(1).max(64),
      memoryMb: z.number().int().min(1024).max(65536),
      port: z.number().int().min(1024).max(65535),
      useServerPack: z.boolean(),
    })
    .strict(),
  "modpacks:manual-files": Id,
  "modpacks:add-manual-files": Id,
  "mods:list": Id,
  "mods:search": z.object({ id: z.string().min(1).max(128), provider: Provider, query: z.string().max(100) }).strict(),
  "mods:versions": z.object({ id: z.string().min(1).max(128), provider: Provider, projectId: z.string().min(1).max(64) }).strict(),
  "mods:plan-add": z.object({ id: z.string().min(1).max(128), provider: Provider, projectId: z.string().min(1).max(64), versionId: z.string().min(1).max(64).nullable() }).strict(),
  "mods:check-updates": Id,
  "mods:plan-update": z
    .object({
      id: z.string().min(1).max(128),
      updates: z.array(z.object({ file: ModFile, provider: Provider, projectId: z.string().min(1).max(64), versionId: z.string().min(1).max(64) }).strict()).min(1).max(500),
    })
    .strict(),
  "mods:apply": z.object({ planId: z.string().uuid() }).strict(),
  "mods:add-files": Id,
  "mods:set-enabled": z.object({ id: z.string().min(1).max(128), files: z.array(ModFile).min(1).max(500), enabled: z.boolean() }).strict(),
  "mods:remove": z.object({ id: z.string().min(1).max(128), files: z.array(ModFile).min(1).max(500) }).strict(),
  "mods:history": Id,
  "mods:undo": z.object({ id: z.string().min(1).max(128), entryId: z.string().min(1).max(128) }).strict(),
  "backups:list": Id,
  "backups:create": z.object({ id: z.string().min(1).max(128), note: z.string().max(200) }).strict(),
  "backups:preview": BackupRef,
  "backups:restore": BackupRef,
  "backups:delete": BackupRef,
  "backups:show": BackupRef,
  "backups:set-schedule": z
    .object({ id: z.string().min(1).max(128), everyHours: z.number().int().min(1).max(168).nullable(), keep: z.number().int().min(1).max(100) })
    .strict(),
  "java:list": Empty,
  "java:detect": Empty,
  "java:install": z.object({ major: z.number().int().min(8).max(25) }).strict(),
  "java:add-custom": Empty,
  "java:verify": Id,
  "java:forget": Id,
  "jobs:list": Empty,
  "jobs:cancel": Id,
  "jobs:clear-finished": Empty,
  "logs:recent": z.object({ limit: z.number().int().min(1).max(2000) }).strict(),
  "shell:open-folder": z.object({ which: z.enum(["data", "logs", "servers", "backups"]) }).strict(),
  "dialog:pick-folder": z.object({ purpose: z.enum(["servers", "java", "backups"]) }).strict(),
} as const;

export type Channel = keyof typeof channels;
export type ChannelInput<C extends Channel> = z.input<(typeof channels)[C]>;

export interface ChannelOutput {
  "app:info": AppInfo;
  "settings:get": SettingsView;
  "settings:update": SettingsView;
  "settings:set-curseforge-key": SettingsView;
  "servers:list": ServerInstance[];
  "servers:statuses": ServerStatus[];
  "servers:create": ServerInstance;
  "servers:remove": boolean;
  "servers:accept-eula": ServerInstance;
  "servers:start": ServerStatus;
  "servers:stop": "stopped" | "timeout" | "not-running";
  "servers:force-stop": boolean;
  "servers:restart": ServerStatus;
  "servers:send-command": boolean;
  "servers:console": ConsoleLine[];
  "servers:get-properties": { values: Record<string, string>; fields: PropertyField[] };
  "servers:update-properties": { values: Record<string, string>; restartRequired: boolean };
  "servers:update-resources": { server: ServerInstance; restartRequired: boolean };
  "servers:open-folder": boolean;
  "minecraft:versions": MinecraftVersionList;
  "loaders:versions": { versions: { version: string; stable: boolean }[]; recommended: string | null };
  "modpacks:search": { hits: PackSearchHit[]; available: boolean };
  "modpacks:versions": { id: string; name: string; gameVersions: string[]; loaders: string[]; date: string; stable: boolean }[];
  "modpacks:inspect": ImportSummary | null;
  "modpacks:install": { server: ServerInstance; clientOnlyRemoved: string[]; manual: ManualFile[] };
  "modpacks:manual-files": ManualFile[];
  "modpacks:add-manual-files": { added: string[]; rejected: string[] } | null;
  "mods:list": ModList;
  "mods:search": { hits: PackSearchHit[]; available: boolean };
  "mods:versions": { id: string; name: string; gameVersions: string[]; loaders: string[]; date: string; stable: boolean }[];
  "mods:plan-add": ModChangePlan;
  "mods:check-updates": ModUpdate[];
  "mods:plan-update": ModChangePlan;
  "mods:apply": { summary: string };
  "mods:add-files": { added: string[]; rejected: string[] } | null;
  "mods:set-enabled": { summary: string };
  "mods:remove": { summary: string };
  "mods:history": ModHistoryEntry[];
  "mods:undo": { summary: string };
  "backups:list": BackupInfo[];
  "backups:create": BackupInfo;
  "backups:preview": RestorePreview;
  "backups:restore": { safetyBackupId: string };
  "backups:delete": boolean;
  "backups:show": boolean;
  "backups:set-schedule": ServerInstance;
  "java:list": JavaRuntime[];
  "java:detect": JavaRuntime[];
  "java:install": JavaRuntime;
  "java:add-custom": JavaRuntime | null;
  "java:verify": JavaRuntime;
  "java:forget": JavaRuntime[];
  "jobs:list": Job[];
  "jobs:cancel": boolean;
  "jobs:clear-finished": Job[];
  "logs:recent": LogEntry[];
  "shell:open-folder": boolean;
  "dialog:pick-folder": string | null;
}

/** Every invoke resolves to this envelope, so errors cross IPC as data, not exceptions. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string; code: "invalid-input" | "failed" };

/** Events the main process pushes to the renderer. */
export interface EventPayload {
  "jobs:changed": Job[];
  "log:entry": LogEntry;
  "server:status": ServerStatus;
  "server:console": { id: string; lines: ConsoleLine[] };
  "server:install": InstallProgress;
  "java:changed": JavaRuntime[];
  "backups:changed": { serverId: string };
}
export type EventName = keyof EventPayload;

/** The object the preload script exposes as `window.nexcraft`. */
export interface NexcraftBridge {
  invoke<C extends Channel>(channel: C, input: ChannelInput<C>): Promise<IpcResult<ChannelOutput[C]>>;
  on<E extends EventName>(event: E, listener: (payload: EventPayload[E]) => void): () => void;
}
