/**
 * Find Java installations already on this PC. Only standard locations are
 * scanned: JAVA_HOME, PATH, the usual vendor folders under Program Files, the
 * Minecraft Launcher's bundled runtimes, and NexCraft's own Java folder.
 */
import fs from "node:fs";
import path from "node:path";

export interface DetectEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  managedDir: string;
}

const WINDOWS_VENDOR_DIRS = [
  "Java",
  "Eclipse Adoptium",
  "Eclipse Foundation",
  "Microsoft",
  "Zulu",
  "Amazon Corretto",
  "BellSoft",
  "Semeru",
  "OpenJDK",
  "AdoptOpenJDK",
];

export function candidateJavaPaths(d: DetectEnv, fsImpl: Pick<typeof fs, "existsSync" | "readdirSync" | "statSync"> = fs): string[] {
  const win = d.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const exe = win ? "java.exe" : "java";
  const found = new Set<string>();
  const add = (file: string) => {
    try {
      if (fsImpl.existsSync(file) && fsImpl.statSync(file).isFile()) found.add(p.normalize(file));
    } catch {
      // Unreadable; skip.
    }
  };
  const children = (dir: string) => {
    try {
      return fsImpl.readdirSync(dir).map((n) => p.join(dir, String(n)));
    } catch {
      return [];
    }
  };
  /** <root>/<install>/bin/java, plus one more level for launcher runtimes. */
  const scanRoot = (root: string, depth = 1) => {
    for (const child of children(root)) {
      add(p.join(child, "bin", exe));
      if (depth > 1) for (const grand of children(child)) scanRoot(grand, depth - 1);
    }
  };

  for (const [key, value] of Object.entries(d.env)) {
    if (!value) continue;
    if (key === "JAVA_HOME" || /^JAVA_HOME_\d+_(X64|AARCH64)$/.test(key)) add(p.join(value, "bin", exe));
  }
  const pathVar = d.env.PATH ?? d.env.Path ?? "";
  for (const dir of pathVar.split(win ? ";" : ":")) if (dir) add(p.join(dir.replace(/^"|"$/g, ""), exe));

  scanRoot(d.managedDir);

  if (win) {
    for (const pf of [d.env.ProgramFiles, d.env["ProgramFiles(x86)"], d.env.ProgramW6432]) {
      if (!pf) continue;
      for (const vendor of WINDOWS_VENDOR_DIRS) scanRoot(p.join(pf, vendor));
      scanRoot(p.join(pf, "Minecraft Launcher", "runtime"), 3);
    }
    if (d.env.APPDATA) scanRoot(p.join(d.env.APPDATA, ".minecraft", "runtime"), 3);
    if (d.env.LOCALAPPDATA) {
      scanRoot(p.join(d.env.LOCALAPPDATA, "Packages", "Microsoft.4297127D64EC6_8wekyb3d8bbwe", "LocalCache", "Local", "runtime"), 3);
      scanRoot(p.join(d.env.LOCALAPPDATA, "Programs", "Eclipse Adoptium"));
    }
  } else {
    scanRoot("/usr/lib/jvm");
    scanRoot("/Library/Java/JavaVirtualMachines");
  }
  return [...found];
}
