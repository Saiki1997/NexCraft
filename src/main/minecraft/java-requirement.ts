/**
 * Which Java a Minecraft server needs.
 *
 * Mojang's version JSON states `javaVersion.majorVersion` for every version from
 * 1.7.10 onward and is the authority. The table below is only a fallback for
 * versions whose JSON lacks it.
 */
export function fallbackJavaMajor(mcVersion: string): number {
  const v = parseRelease(mcVersion);
  if (!v) return 21; // Unknown or snapshot naming: assume current.
  if (v.minor < 17) return 8;
  if (v.minor === 17) return 16;
  if (v.minor < 20 || (v.minor === 20 && v.patch < 5)) return 17;
  return 21;
}

/**
 * Pick which managed runtime to install for a requirement. Adoptium only ships
 * JREs for LTS lines; Java 16 has no JRE build, and 1.17 runs fine on 17.
 */
export function installableMajor(required: number): number {
  if (required <= 8) return 8;
  if (required <= 11) return 11;
  if (required <= 17) return 17;
  if (required <= 21) return 21;
  return 25;
}

export type JavaFit = "ok" | "too-old" | "too-new-risky";

/**
 * Whether a runtime suits a server. Vanilla servers run on any Java at or above
 * the requirement, but servers that need Java 8 (1.16 and older) commonly break
 * on 17+ with mods and old libraries, so that is flagged rather than allowed silently.
 */
export function javaFit(runtimeMajor: number, requiredMajor: number): JavaFit {
  if (runtimeMajor < requiredMajor) return "too-old";
  if (requiredMajor <= 8 && runtimeMajor > 11) return "too-new-risky";
  return "ok";
}

/** Map the class-file version from an UnsupportedClassVersionError to a Java major. */
export function javaMajorForClassVersion(classVersion: number): number {
  return Math.round(classVersion) - 44;
}

function parseRelease(id: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(id);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}
