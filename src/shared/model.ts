/**
 * NexCraft's persisted data model. Everything the main process saves to disk is
 * described here as a zod schema, so stored data is validated on every load and
 * the renderer and main process share one set of types.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const ServerTypeSchema = z.enum(["vanilla", "fabric", "quilt", "forge", "neoforge"]);
export type ServerType = z.infer<typeof ServerTypeSchema>;

export const ThemeSchema = z.enum(["dark", "light", "system"]);
export type Theme = z.infer<typeof ThemeSchema>;

/** An encrypted secret: base64 ciphertext from Electron safeStorage. Never plain text. */
export const SealedSecretSchema = z.object({
  sealed: z.string().min(1),
});
export type SealedSecret = z.infer<typeof SealedSecretSchema>;

export const SettingsSchema = z.object({
  theme: ThemeSchema.default("dark"),
  /** Where new servers are created. Empty means "<data dir>/servers". */
  serversDir: z.string().default(""),
  /** Where downloaded Java runtimes live. Empty means "<data dir>/java". */
  javaDir: z.string().default(""),
  /** Where backups are written. Empty means "<data dir>/backups". */
  backupsDir: z.string().default(""),
  maxParallelDownloads: z.number().int().min(1).max(8).default(3),
  /**
   * What happens to running servers when NexCraft quits. Servers are children of
   * NexCraft (it holds their console), so quitting always stops them gracefully;
   * this only controls whether NexCraft asks first.
   */
  onQuit: z.enum(["ask", "stop-servers"]).default("ask"),
  curseforgeKeyOverride: SealedSecretSchema.nullable().default(null),
  lastSelectedServerId: z.string().nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const JavaRuntimeSchema = z.object({
  id: z.string(),
  /** Absolute path to java.exe (or javaw.exe). */
  executable: z.string(),
  /** Major version, e.g. 8, 17, 21. */
  major: z.number().int().positive(),
  /** Full version string as printed by the runtime. */
  version: z.string(),
  vendor: z.string().default(""),
  arch: z.enum(["x64", "x86", "arm64", "unknown"]).default("unknown"),
  source: z.enum(["detected", "managed", "custom"]),
  lastVerifiedAt: z.string().nullable().default(null),
});
export type JavaRuntime = z.infer<typeof JavaRuntimeSchema>;

export const ServerInstanceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(64),
  directory: z.string(),
  minecraftVersion: z.string(),
  type: ServerTypeSchema,
  loaderVersion: z.string().nullable().default(null),
  javaRuntimeId: z.string().nullable().default(null),
  /** Java major version this server needs, from Mojang's metadata. */
  requiredJava: z.number().int().positive().default(21),
  /** Path of the server JAR relative to `directory`. */
  serverJar: z.string().default("server.jar"),
  /**
   * How to start the server after the JVM memory options. Empty means
   * `-jar <serverJar> nogui`. Mod loaders set their own, e.g. Forge's argument file.
   */
  launchArgs: z.array(z.string()).default([]),
  memoryMb: z.number().int().min(512).max(262144).default(4096),
  extraJvmArgs: z.array(z.string()).default([]),
  port: z.number().int().min(1).max(65535).default(25565),
  eulaAccepted: z.boolean().default(false),
  eulaAcceptedAt: z.string().nullable().default(null),
  autoRestart: z.boolean().default(false),
  createdAt: z.string(),
  lastStartedAt: z.string().nullable().default(null),
  lastBackupAt: z.string().nullable().default(null),
  modpack: z
    .object({
      source: z.enum(["curseforge", "modrinth", "local"]),
      projectId: z.string().nullable(),
      versionId: z.string().nullable(),
      name: z.string(),
    })
    .nullable()
    .default(null),
});
export type ServerInstance = z.infer<typeof ServerInstanceSchema>;

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  id: z.string(),
  kind: z.enum(["download", "install", "backup", "restore", "modpack-import"]),
  title: z.string(),
  status: JobStatusSchema,
  serverId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 0..1, or null when progress is unknown. */
  progress: z.number().min(0).max(1).nullable().default(null),
  bytesDone: z.number().nonnegative().default(0),
  bytesTotal: z.number().nonnegative().nullable().default(null),
  error: z.string().nullable().default(null),
  /** True when the job can be safely restarted after an interruption. */
  resumable: z.boolean().default(false),
});
export type Job = z.infer<typeof JobSchema>;

export const AppStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  settings: SettingsSchema,
  servers: z.array(ServerInstanceSchema).default([]),
  javaRuntimes: z.array(JavaRuntimeSchema).default([]),
  jobs: z.array(JobSchema).default([]),
});
export type AppState = z.infer<typeof AppStateSchema>;

export function defaultAppState(): AppState {
  return AppStateSchema.parse({ schemaVersion: SCHEMA_VERSION, settings: {} });
}

/** The jobs list is history, not an archive: keep the newest finished ones only. */
export const MAX_FINISHED_JOBS = 200;
