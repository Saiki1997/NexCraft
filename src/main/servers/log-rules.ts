/**
 * Recognise common server problems from console output and explain them in plain
 * language with a suggested fix. Each rule matches one line; findings are
 * de-duplicated per server session.
 */
import { javaMajorForClassVersion } from "../minecraft/java-requirement";

export type FindingSeverity = "error" | "warning" | "info";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  fix: string;
  line: string;
}

interface Rule {
  id: string;
  severity: FindingSeverity;
  test: RegExp;
  build: (m: RegExpExecArray) => Omit<Finding, "id" | "severity" | "line">;
}

const RULES: Rule[] = [
  {
    id: "eula",
    severity: "error",
    test: /You need to agree to the EULA in order to run the server/i,
    build: () => ({
      title: "Minecraft EULA not accepted",
      explanation: "Mojang requires every server owner to accept the Minecraft End User License Agreement before the server will start.",
      fix: "Open the server, read the EULA, and accept it if you agree. NexCraft never accepts it for you.",
    }),
  },
  {
    id: "port-in-use",
    severity: "error",
    test: /FAILED TO BIND TO PORT|Address already in use: bind|BindException/i,
    build: () => ({
      title: "The server port is already in use",
      explanation: "Another program, or another Minecraft server, is already listening on this server's port.",
      fix: "Stop the other server, or change this server's port in its settings.",
    }),
  },
  {
    id: "java-too-old",
    severity: "error",
    test: /UnsupportedClassVersionError.*class file version (\d+(?:\.\d+)?)/,
    build: (m) => {
      const needed = javaMajorForClassVersion(Number(m[1]));
      return {
        title: `This server needs Java ${needed} or newer`,
        explanation: `The server was built for Java ${needed}, but it was started with an older Java.`,
        fix: `Choose or install Java ${needed} for this server in its settings.`,
      };
    },
  },
  {
    id: "heap-reserve",
    severity: "error",
    test: /Could not reserve enough space for .*object heap|Invalid maximum heap size/i,
    build: () => ({
      title: "Java could not reserve the requested memory",
      explanation: "The memory allocated to this server is more than Windows could give it, or the Java in use is 32-bit.",
      fix: "Lower the server's memory setting, close other programs, or use a 64-bit Java.",
    }),
  },
  {
    id: "out-of-memory",
    severity: "error",
    test: /java\.lang\.OutOfMemoryError/,
    build: () => ({
      title: "The server ran out of memory",
      explanation: "The server used all of the memory allocated to it.",
      fix: "Increase the server's memory, lower view and simulation distance, or remove heavy mods.",
    }),
  },
  {
    id: "corrupt-jar",
    severity: "error",
    test: /Invalid or corrupt jarfile|Unable to access jarfile|zip file is empty|error in opening zip file/i,
    build: () => ({
      title: "The server JAR is missing or damaged",
      explanation: "Java could not open the server's JAR file.",
      fix: "Repair the server from its settings so NexCraft downloads and verifies the server file again.",
    }),
  },
  {
    id: "world-corrupt",
    severity: "error",
    test: /(Failed to load level|Exception reading .*level\.dat|Couldn't load chunk|Chunk file at .* is in the wrong location|Region file .* is truncated)/i,
    build: () => ({
      title: "World data may be damaged",
      explanation: "The server reported a problem reading the world files.",
      fix: "Stop the server and restore the world from a backup. Do not keep playing on a damaged world.",
    }),
  },
  {
    id: "cant-keep-up",
    severity: "warning",
    test: /Can't keep up! Is the server overloaded\? Running (\d+)ms or (\d+) ticks behind/,
    build: (m) => ({
      title: "The server is falling behind",
      explanation: `The server was ${m[1]} ms (${m[2]} ticks) behind. Short spikes during startup or world generation are normal.`,
      fix: "If this keeps happening, lower view and simulation distance or allocate more memory.",
    }),
  },
  {
    id: "offline-mode",
    severity: "info",
    test: /SERVER IS RUNNING IN OFFLINE\/INSECURE MODE/,
    build: () => ({
      title: "Online mode is off",
      explanation: "Players are not checked against Microsoft accounts, so anyone can join with any name.",
      fix: "Turn on online mode unless you have a specific reason not to.",
    }),
  },
  {
    id: "loader-too-old",
    severity: "error",
    test: /Unsupported class file major version (\d+)/,
    build: (m) => ({
      title: "The mod loader is too old for this Minecraft version",
      explanation: `The loader or a mod could not read Minecraft's code (class file version ${m[1]}, made for Java ${Number(m[1]) - 44}). The loader version does not support this Minecraft release yet.`,
      fix: "Create the server with a newer loader version, or choose an older Minecraft version that the loader supports.",
    }),
  },
  {
    id: "client-only-mod",
    severity: "error",
    test: /(Attempted to load class net\/minecraft\/client|Environment type CLIENT|invalid dist DEDICATED_SERVER|NoClassDefFoundError: net\/minecraft\/client)/,
    build: () => ({
      title: "A client-only mod is installed",
      explanation: "A mod that only works in the game client (for example a minimap, shader or HUD mod) was loaded on the server.",
      fix: "Remove the client-only mod from the server's mods folder. The lines above this one in the console usually name it.",
    }),
  },
  {
    id: "mod-dependencies",
    severity: "error",
    test: /(Incompatible mods? (set|found)|Missing or unsupported mandatory dependencies|requires (any version|version) .* of ['"]?[\w-]+['"]?, which is missing)/i,
    build: () => ({
      title: "Mods are missing a dependency or conflict",
      explanation: "The mod loader refused to start because a mod needs another mod (or a different version of one) that is not installed.",
      fix: "Read the lines after this one: they list each mod and what it needs. Add or update those mods, or remove the mod that needs them.",
    }),
  },
  {
    id: "mixin-failure",
    severity: "error",
    test: /(Mixin apply failed|MixinApplyError|Mixin transformation of .* failed)/,
    build: () => ({
      title: "Two mods clash, or a mod is for another Minecraft version",
      explanation: "A mod failed to modify the game's code. This usually means it does not match this Minecraft or loader version, or conflicts with another mod.",
      fix: "Check that every mod is built for this Minecraft version and loader. The mod named near this line is the likely cause.",
    }),
  },
];

export function matchLine(line: string): Finding | null {
  for (const rule of RULES) {
    const m = rule.test.exec(line);
    if (m) return { id: rule.id, severity: rule.severity, line: line.slice(0, 500), ...rule.build(m) };
  }
  return null;
}

/** Server lifecycle milestones read from vanilla console output. */
export const READY_LINE = /\]: Done \(([\d.,]+)s\)! For help, type "help"/;
export const STOPPING_LINE = /\]: Stopping (the )?server/;
export const JOIN_LINE = /\]: (\w{1,16}) joined the game/;
export const LEAVE_LINE = /\]: (\w{1,16}) left the game/;
