/** Server-related types shared by the main process and the UI. */
import { z } from "zod";

export const CreateServerInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give the server a name").max(64),
    minecraftVersion: z.string().min(1).max(32).regex(/^[\w.\-]+$/),
    type: z.enum(["vanilla", "fabric", "quilt", "forge", "neoforge"]),
    /** Loader version for modded servers; null picks the recommended one. */
    loaderVersion: z.string().max(64).regex(/^[\w.\-+]+$/).nullable().default(null),
    /** Absolute parent folder; empty uses the configured servers folder. */
    parentDir: z.string().max(1024).default(""),
    worldName: z.string().trim().min(1).max(64).regex(/^[^<>:"/\\|?*\x00-\x1f]+$/, "Not a valid folder name").default("world"),
    seed: z.string().max(64).default(""),
    port: z.number().int().min(1024).max(65535).default(25565),
    maxPlayers: z.number().int().min(1).max(1000).default(20),
    onlineMode: z.boolean().default(true),
    difficulty: z.enum(["peaceful", "easy", "normal", "hard"]).default("easy"),
    gamemode: z.enum(["survival", "creative", "adventure", "spectator"]).default("survival"),
    viewDistance: z.number().int().min(3).max(32).default(10),
    simulationDistance: z.number().int().min(3).max(32).default(10),
    memoryMb: z.number().int().min(1024).max(65536).default(4096),
    motd: z.string().max(150).default(""),
    /** A specific registered runtime, or null to choose (and install if needed) automatically. */
    javaRuntimeId: z.string().nullable().default(null),
    autoRestart: z.boolean().default(false),
  })
  .strict();
export type CreateServerInput = z.input<typeof CreateServerInputSchema>;

export type ServerState = "stopped" | "starting" | "running" | "stopping" | "crashed";

export interface ServerFinding {
  id: string;
  severity: "error" | "warning" | "info";
  title: string;
  explanation: string;
  fix: string;
  line: string;
  at: string;
}

export interface ServerStatus {
  id: string;
  state: ServerState;
  pid: number | null;
  startedAt: string | null;
  readyAt: string | null;
  startupSeconds: number | null;
  players: string[];
  cpuPercent: number | null;
  memoryMb: number | null;
  lastExit: { code: number | null; at: string; requested: boolean } | null;
  findings: ServerFinding[];
}

export interface ConsoleLine {
  seq: number;
  at: string;
  stream: "stdout" | "stderr" | "system" | "input";
  text: string;
}

export interface InstallProgress {
  key: string;
  step: "version" | "java" | "download" | "loader" | "files" | "done" | "failed";
  message: string;
}

/** Warn when the requested heap leaves too little memory for Windows and other programs. */
export function memoryWarning(memoryMb: number, totalMb: number): string | null {
  if (memoryMb > totalMb - 2048) return `This leaves less than 2 GB for Windows and other programs (this PC has ${Math.round(totalMb / 1024)} GB).`;
  if (memoryMb > totalMb * 0.75) return "This is more than three quarters of this PC's memory. Other programs may slow down.";
  return null;
}

export const ResourcesPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    memoryMb: z.number().int().min(1024).max(65536),
    extraJvmArgs: z.array(z.string().max(200)).max(40),
    javaRuntimeId: z.string().max(128).nullable(),
    autoRestart: z.boolean(),
  })
  .partial()
  .strict();
export type ResourcesPatch = z.infer<typeof ResourcesPatchSchema>;
