/**
 * Read and write `server.properties` without losing anything: comments, key order
 * and keys NexCraft does not know about are preserved. Known keys are validated
 * before they are written.
 */
import { z } from "zod";

export interface PropertyDef {
  key: string;
  label: string;
  group: "World" | "Players" | "Network" | "Performance" | "Gameplay";
  schema: z.ZodType<string>;
  defaultValue: string;
  help: string;
}

const bool = z.enum(["true", "false"]);
const int = (min: number, max: number) =>
  z
    .string()
    .regex(/^-?\d+$/, "Must be a whole number")
    .refine((v) => Number(v) >= min && Number(v) <= max, `Must be between ${min} and ${max}`);
const text = (max: number) => z.string().max(max).refine((v) => !/[\r\n]/.test(v), "Must be a single line");

export const PROPERTY_DEFS: PropertyDef[] = [
  { key: "motd", label: "Message of the day", group: "Network", schema: text(150), defaultValue: "A Minecraft Server", help: "Shown in the multiplayer server list." },
  { key: "server-port", label: "Port", group: "Network", schema: int(1, 65535), defaultValue: "25565", help: "TCP port players connect to." },
  { key: "online-mode", label: "Online mode", group: "Network", schema: bool, defaultValue: "true", help: "Check players against Microsoft accounts. Turning this off allows anyone to join as any name." },
  { key: "enable-rcon", label: "RCON", group: "Network", schema: bool, defaultValue: "false", help: "Remote console over the network. Only enable with a strong password." },
  { key: "max-players", label: "Max players", group: "Players", schema: int(1, 1000), defaultValue: "20", help: "How many players can be online at once." },
  { key: "white-list", label: "Whitelist", group: "Players", schema: bool, defaultValue: "false", help: "Only players on the whitelist can join." },
  { key: "enforce-whitelist", label: "Enforce whitelist", group: "Players", schema: bool, defaultValue: "false", help: "Kick players not on the whitelist when it is reloaded." },
  { key: "pvp", label: "PvP", group: "Gameplay", schema: bool, defaultValue: "true", help: "Players can damage each other." },
  { key: "gamemode", label: "Game mode", group: "Gameplay", schema: z.enum(["survival", "creative", "adventure", "spectator"]), defaultValue: "survival", help: "Default game mode for new players." },
  { key: "difficulty", label: "Difficulty", group: "Gameplay", schema: z.enum(["peaceful", "easy", "normal", "hard"]), defaultValue: "easy", help: "World difficulty." },
  { key: "hardcore", label: "Hardcore", group: "Gameplay", schema: bool, defaultValue: "false", help: "Players are set to spectator when they die." },
  { key: "allow-flight", label: "Allow flight", group: "Gameplay", schema: bool, defaultValue: "false", help: "Stops the server kicking players for flying; some mods need this." },
  { key: "spawn-protection", label: "Spawn protection", group: "Gameplay", schema: int(0, 1000), defaultValue: "16", help: "Radius around spawn that only operators can build in." },
  { key: "level-name", label: "World folder", group: "World", schema: z.string().min(1).max(64).regex(/^[^<>:"/\\|?*\x00-\x1f]+$/, "Not a valid folder name"), defaultValue: "world", help: "Folder name of the world." },
  { key: "level-seed", label: "Seed", group: "World", schema: text(64), defaultValue: "", help: "Leave empty for a random seed. Only used when the world is first created." },
  { key: "level-type", label: "World type", group: "World", schema: z.enum(["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface", "default", "flat", "largebiomes", "amplified"]), defaultValue: "minecraft:normal", help: "Only used when the world is first created." },
  { key: "view-distance", label: "View distance", group: "Performance", schema: int(3, 32), defaultValue: "10", help: "Chunks sent to players. Higher uses more CPU, memory and bandwidth." },
  { key: "simulation-distance", label: "Simulation distance", group: "Performance", schema: int(3, 32), defaultValue: "10", help: "Chunks around players where the world keeps ticking." },
];

const DEF_BY_KEY = new Map(PROPERTY_DEFS.map((d) => [d.key, d]));

type Line = { kind: "pair"; key: string; value: string } | { kind: "other"; raw: string };

export class ServerProperties {
  private constructor(private readonly lines: Line[]) {}

  static parse(text: string): ServerProperties {
    const lines: Line[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const trimmed = raw.trimStart();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
        lines.push({ kind: "other", raw });
        continue;
      }
      const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(trimmed);
      if (!m) lines.push({ kind: "other", raw });
      else lines.push({ kind: "pair", key: unescape(m[1]), value: unescape(m[2]) });
    }
    while (lines.length && lines.at(-1)!.kind === "other" && (lines.at(-1) as { raw: string }).raw === "") lines.pop();
    return new ServerProperties(lines);
  }

  static fresh(values: Record<string, string>): ServerProperties {
    const props = new ServerProperties([{ kind: "other", raw: "#Minecraft server properties" }, { kind: "other", raw: "#Written by NexCraft" }]);
    props.setMany(values);
    return props;
  }

  get(key: string): string | undefined {
    const line = this.lines.find((l): l is Extract<Line, { kind: "pair" }> => l.kind === "pair" && l.key === key);
    return line?.value;
  }

  entries(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const l of this.lines) if (l.kind === "pair") out[l.key] = l.value;
    return out;
  }

  /** Validate then set; throws listing every invalid field, changing nothing. */
  setMany(values: Record<string, string>) {
    const errors = validateProperties(values);
    if (errors.length) throw new Error(errors.map((e) => `${e.key}: ${e.message}`).join("; "));
    for (const [k, v] of Object.entries(values)) {
      const line = this.lines.find((l): l is Extract<Line, { kind: "pair" }> => l.kind === "pair" && l.key === k);
      if (line) line.value = v;
      else this.lines.push({ kind: "pair", key: k, value: v });
    }
  }

  toString(): string {
    return this.lines.map((l) => (l.kind === "other" ? l.raw : `${escapeKey(l.key)}=${escapeValue(l.value)}`)).join("\n") + "\n";
  }
}

export function validateProperties(values: Record<string, string>): { key: string; message: string }[] {
  const errors: { key: string; message: string }[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z0-9][a-z0-9.\-]*$/i.test(key)) {
      errors.push({ key, message: "Not a valid property name" });
      continue;
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      errors.push({ key, message: "Must be a single line" });
      continue;
    }
    const def = DEF_BY_KEY.get(key);
    if (def) {
      const r = def.schema.safeParse(value);
      if (!r.success) errors.push({ key, message: r.error.issues[0]?.message ?? "Invalid value" });
    }
  }
  return errors;
}

function unescape(s: string) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, c: string) => {
    if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
  });
}

function escapeKey(s: string) {
  return s.replace(/[\\=:\s#!]/g, (c) => `\\${c}`);
}

function escapeValue(s: string) {
  // Java Properties files are read as ISO-8859-1 by older servers; escape non-ASCII.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/^\s/, (c) => `\\${c}`)
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
