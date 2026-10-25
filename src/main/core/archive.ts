/**
 * Safe ZIP extraction. Archives (Java runtimes, modpacks, server packs) are
 * untrusted: every entry is resolved inside the destination with safe-path,
 * symbolic links and device entries are refused, and total size, entry count
 * and per-entry compression ratio are capped against zip bombs.
 */
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import zlib from "node:zlib";
import yauzl from "yauzl";
import { resolveInside } from "./safe-path";

export interface ExtractLimits {
  maxEntries: number;
  maxTotalBytes: number;
  /** Uncompressed / compressed, per entry. */
  maxRatio: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxEntries: 50_000,
  maxTotalBytes: 8 * 1024 ** 3,
  maxRatio: 200,
};

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface ExtractResult {
  files: number;
  bytes: number;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** List entry names without extracting (used to inspect modpacks before installing). */
export async function listZip(file: string): Promise<{ name: string; size: number; directory: boolean }[]> {
  const zip = await open(file);
  const out: { name: string; size: number; directory: boolean }[] = [];
  try {
    await forEachEntry(zip, async (entry) => {
      out.push({ name: entry.fileName, size: entry.uncompressedSize, directory: entry.fileName.endsWith("/") });
    });
  } finally {
    zip.close();
  }
  return out;
}

/** Read one small entry fully into memory, e.g. `manifest.json`. */
export async function readZipEntry(file: string, name: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer | null> {
  const zip = await open(file);
  let found: Buffer | null = null;
  try {
    await forEachEntry(zip, async (entry) => {
      if (found || entry.fileName !== name) return;
      if (entry.uncompressedSize > maxBytes) throw new ArchiveError(`${name} is too large to read (${entry.uncompressedSize} bytes)`);
      const stream = await openStream(zip, entry);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        total += (chunk as Buffer).length;
        if (total > maxBytes) throw new ArchiveError(`${name} is larger than it claims`);
        chunks.push(chunk as Buffer);
      }
      found = Buffer.concat(chunks);
    });
  } finally {
    zip.close();
  }
  return found;
}

/**
 * Extract `file` into `dest`. `stripPrefix` removes a leading folder (for archives
 * that wrap everything in one top-level directory). `filter` can skip entries.
 */
/** Read several small entries in one pass. Missing entries are left out of the result. */
export async function readZipEntries(file: string | Buffer, names: string[], maxBytes = 4 * 1024 * 1024): Promise<Map<string, Buffer>> {
  const wanted = new Set(names);
  const found = new Map<string, Buffer>();
  const zip = await open(file);
  try {
    await forEachEntry(zip, async (entry) => {
      if (!wanted.has(entry.fileName) || found.has(entry.fileName)) return;
      if (entry.uncompressedSize > maxBytes) return;
      const stream = await openStream(zip, entry);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        total += (chunk as Buffer).length;
        if (total > maxBytes) throw new ArchiveError(`${entry.fileName} is larger than it claims`);
        chunks.push(chunk as Buffer);
      }
      found.set(entry.fileName, Buffer.concat(chunks));
    });
  } finally {
    zip.close();
  }
  return found;
}

/**
 * Read every entry of an archive back and check it against its stored CRC-32,
 * so a backup is only trusted once it is known to be readable in full.
 */
export async function verifyZip(file: string): Promise<{ entries: number; bytes: number }> {
  const zip = await open(file);
  let entries = 0;
  let bytes = 0;
  try {
    await forEachEntry(zip, async (entry) => {
      entries++;
      if (entry.fileName.endsWith("/")) return;
      const stream = await openStream(zip, entry);
      let crc = 0;
      let size = 0;
      for await (const chunk of stream) {
        crc = zlib.crc32(chunk as Buffer, crc);
        size += (chunk as Buffer).length;
      }
      if (size !== entry.uncompressedSize || crc >>> 0 !== entry.crc32 >>> 0) throw new ArchiveError(`${entry.fileName} is damaged in the archive`);
      bytes += size;
    });
  } finally {
    zip.close();
  }
  return { entries, bytes };
}

export async function extractZip(
  file: string,
  dest: string,
  opts: {
    limits?: Partial<ExtractLimits>;
    stripPrefix?: string;
    filter?: (name: string) => boolean;
    signal?: AbortSignal;
    /** Replace existing regular files (e.g. pack overrides over defaults). Links and folders are never replaced. */
    overwrite?: boolean;
  } = {},
): Promise<ExtractResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  fs.mkdirSync(dest, { recursive: true });
  const zip = await open(file);
  let files = 0;
  let bytes = 0;
  let entries = 0;
  try {
    await forEachEntry(zip, async (entry) => {
      if (opts.signal?.aborted) throw new ArchiveError("Cancelled");
      entries++;
      if (entries > limits.maxEntries) throw new ArchiveError(`Archive has more than ${limits.maxEntries} entries`);

      let name = entry.fileName;
      if (opts.stripPrefix) {
        if (!name.startsWith(opts.stripPrefix)) return;
        name = name.slice(opts.stripPrefix.length);
        if (!name) return;
      }
      if (opts.filter && !opts.filter(name)) return;

      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const kind = mode & S_IFMT;
      if (kind === S_IFLNK) throw new ArchiveError(`Archive contains a symbolic link (${entry.fileName}), which is not allowed`);
      if (kind !== 0 && kind !== S_IFREG && kind !== S_IFDIR) throw new ArchiveError(`Archive contains a special file (${entry.fileName})`);

      const isDir = name.endsWith("/");
      const target = resolveInside(dest, isDir ? name.slice(0, -1) || "." : name);
      if (isDir) {
        fs.mkdirSync(target, { recursive: true });
        return;
      }
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxRatio && entry.uncompressedSize > 1024 * 1024) {
        throw new ArchiveError(`${entry.fileName} has a suspicious compression ratio`);
      }
      if (bytes + entry.uncompressedSize > limits.maxTotalBytes) throw new ArchiveError("Archive is larger than allowed");

      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (opts.overwrite) {
        const existing = fs.lstatSync(target, { throwIfNoEntry: false });
        if (existing && !existing.isFile()) throw new ArchiveError(`${entry.fileName} would replace a folder or link`);
        if (existing) fs.unlinkSync(target);
      }
      const stream = await openStream(zip, entry);
      let written = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (written > entry.uncompressedSize || bytes + written > limits.maxTotalBytes) {
            cb(new ArchiveError(`${entry.fileName} is larger than its header says`));
            return;
          }
          cb(null, chunk);
        },
      });
      // "wx" never follows or overwrites an existing file or link at the target.
      await pipeline(stream, guard, fs.createWriteStream(target, { flags: "wx" }));
      bytes += written;
      files++;
    });
  } finally {
    zip.close();
  }
  return { files, bytes };
}

/** Open a ZIP from disk, or from memory for archives nested inside another (jar-in-jar). */
function open(file: string | Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, zip?: yauzl.ZipFile) => {
      if (err || !zip) reject(new ArchiveError(`Not a readable ZIP archive: ${err?.message ?? "unknown error"}`));
      else resolve(zip);
    };
    const options = { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false };
    if (typeof file === "string") yauzl.open(file, options, done);
    else yauzl.fromBuffer(file, options, done);
  });
}

function openStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err ?? new ArchiveError("Cannot read entry")) : resolve(stream)));
  });
}

function forEachEntry(zip: yauzl.ZipFile, fn: (entry: yauzl.Entry) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let failed = false;
    zip.on("entry", (entry: yauzl.Entry) => {
      fn(entry).then(
        () => zip.readEntry(),
        (err) => {
          failed = true;
          reject(err);
        },
      );
    });
    zip.on("end", () => !failed && resolve());
    zip.on("error", (err) => {
      failed = true;
      reject(new ArchiveError(err.message));
    });
    zip.readEntry();
  });
}
