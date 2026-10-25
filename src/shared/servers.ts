/** Server-related types shared by the main process and the UI. */
import { z } from "zod";

export const CreateServerInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give the server a name").max(64),
    minecraftVersion: z.string().min(1).max(32).regex(/^[\w.\-]+$/),
    type: z.literal("vanilla"),
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
  step: "version" | "java" | "download" | "files" | "done" | "failed";
  message: string;
}
