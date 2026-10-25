/**
 * The complete IPC surface between the renderer and the main process.
 *
 * Every channel has a zod schema for its input, and the main process rejects any
 * call whose input does not match. The renderer can only call the channels listed
 * here; there is deliberately no channel that runs a command, spawns an arbitrary
 * executable, or reads/writes an arbitrary path.
 */
import { z } from "zod";
import type { Job, ServerInstance, Settings } from "./model";
import { ThemeSchema } from "./model";

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

export const channels = {
  "app:info": Empty,
  "settings:get": Empty,
  "settings:update": SettingsPatchSchema,
  "settings:set-curseforge-key": z.object({ key: z.string().trim().max(200).nullable() }).strict(),
  "servers:list": Empty,
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
}
export type EventName = keyof EventPayload;

/** The object the preload script exposes as `window.nexcraft`. */
export interface NexcraftBridge {
  invoke<C extends Channel>(channel: C, input: ChannelInput<C>): Promise<IpcResult<ChannelOutput[C]>>;
  on<E extends EventName>(event: E, listener: (payload: EventPayload[E]) => void): () => void;
}
