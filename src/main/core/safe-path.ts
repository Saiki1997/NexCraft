/**
 * Path containment helpers. Anything that turns untrusted text (an archive entry,
 * a manifest path, a file name from an API) into a filesystem path goes through
 * here first.
 */
import path from "node:path";

export class UnsafePathError extends Error {
  constructor(
    message: string,
    readonly input: string,
  ) {
    super(message);
    this.name = "UnsafePathError";
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** True when `target` is `root` itself or somewhere beneath it. */
export function isInside(root: string, target: string, p: typeof path = path): boolean {
  const rel = p.relative(p.resolve(root), p.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/**
 * Resolve a relative path (for example an archive entry such as
 * `overrides/config/foo.toml`) inside `root`, refusing anything that would land
 * outside it: absolute paths, drive letters, `..` segments, NUL bytes, and
 * Windows device names.
 */
export function resolveInside(root: string, relative: string, p: typeof path = path): string {
  if (typeof relative !== "string" || relative.length === 0) throw new UnsafePathError("Empty path", String(relative));
  if (relative.includes("\0")) throw new UnsafePathError("Path contains a NUL byte", relative);
  const normalized = relative.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) {
    throw new UnsafePathError("Absolute paths are not allowed", relative);
  }
  const segments = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) throw new UnsafePathError("Path has no file name", relative);
  for (const segment of segments) {
    if (segment === "..") throw new UnsafePathError("Parent-directory segments are not allowed", relative);
    if (WINDOWS_RESERVED.test(segment)) throw new UnsafePathError(`"${segment}" is a reserved Windows name`, relative);
    if (/[<>:"|?*\x00-\x1f]/.test(segment)) throw new UnsafePathError(`"${segment}" contains characters Windows does not allow`, relative);
    if (/[. ]$/.test(segment)) throw new UnsafePathError(`"${segment}" ends with a dot or space`, relative);
  }
  const resolved = p.resolve(root, ...segments);
  if (!isInside(root, resolved, p)) throw new UnsafePathError("Path escapes its folder", relative);
  return resolved;
}

/** Turn arbitrary text (a server name, a mod title) into a safe single folder or file name. */
export function toSafeName(input: string, fallback = "untitled"): string {
  const cleaned = input
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 64);
  if (!cleaned || WINDOWS_RESERVED.test(cleaned)) return fallback;
  return cleaned;
}
