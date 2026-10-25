import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../../../test/helpers/tmp";
import { buildZip, type FixtureEntry } from "../../../test/helpers/zip";
import { extractZip, listZip, readZipEntry } from "./archive";

function zipFile(entries: FixtureEntry[]) {
  const file = path.join(tmpDir(), "a.zip");
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

describe("extractZip", () => {
  it("extracts files and folders, stored and deflated", async () => {
    const file = zipFile([
      { name: "jdk/" },
      { name: "jdk/bin/java.exe", data: "MZ fake" },
      { name: "jdk/release", data: 'JAVA_VERSION="21.0.5"\n'.repeat(50), deflate: true },
    ]);
    const dest = tmpDir();
    const r = await extractZip(file, dest);
    expect(r.files).toBe(2);
    expect(fs.readFileSync(path.join(dest, "jdk/bin/java.exe"), "utf8")).toBe("MZ fake");
  });

  it("strips a leading folder", async () => {
    const file = zipFile([{ name: "jdk-21/bin/java.exe", data: "x" }, { name: "other/skip.txt", data: "y" }]);
    const dest = tmpDir();
    await extractZip(file, dest, { stripPrefix: "jdk-21/" });
    expect(fs.existsSync(path.join(dest, "bin/java.exe"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "other"))).toBe(false);
  });

  it.each([["../evil.txt"], ["a/../../evil.txt"], ["/abs/evil.txt"], ["C:/evil.txt"], ["..\\evil.txt"]])("refuses traversal entry %j", async (name) => {
    const outside = tmpDir();
    const dest = path.join(outside, "dest");
    await expect(extractZip(zipFile([{ name, data: "pwned" }]), dest)).rejects.toThrow();
    expect(fs.existsSync(path.join(outside, "evil.txt"))).toBe(false);
  });

  it("refuses symbolic links", async () => {
    const file = zipFile([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]);
    await expect(extractZip(file, tmpDir())).rejects.toThrow(/symbolic link/);
  });

  it("refuses entries that are bigger than their header claims", async () => {
    const file = zipFile([{ name: "big.bin", data: Buffer.alloc(5000), claimedSize: 10 }]);
    await expect(extractZip(file, tmpDir())).rejects.toThrow();
  });

  it("enforces total size and entry limits", async () => {
    const file = zipFile([{ name: "a", data: Buffer.alloc(600) }, { name: "b", data: Buffer.alloc(600) }]);
    await expect(extractZip(file, tmpDir(), { limits: { maxTotalBytes: 1000 } })).rejects.toThrow(/larger than allowed/);
    await expect(extractZip(file, tmpDir(), { limits: { maxEntries: 1 } })).rejects.toThrow(/more than 1 entries/);
  });

  it("refuses a highly compressed bomb entry", async () => {
    const file = zipFile([{ name: "bomb.bin", data: Buffer.alloc(4 * 1024 * 1024), deflate: true }]);
    await expect(extractZip(file, tmpDir())).rejects.toThrow(/compression ratio/);
  });

  it("never overwrites a file that already exists", async () => {
    const dest = tmpDir();
    fs.writeFileSync(path.join(dest, "keep.txt"), "original");
    await expect(extractZip(zipFile([{ name: "keep.txt", data: "new" }]), dest)).rejects.toThrow();
    expect(fs.readFileSync(path.join(dest, "keep.txt"), "utf8")).toBe("original");
  });

  it("rejects files that are not ZIPs", async () => {
    const file = path.join(tmpDir(), "x.zip");
    fs.writeFileSync(file, "not a zip");
    await expect(extractZip(file, tmpDir())).rejects.toThrow(/Not a readable ZIP/);
  });
});

describe("listZip and readZipEntry", () => {
  it("lists entries and reads one without extracting", async () => {
    const file = zipFile([{ name: "manifest.json", data: '{"a":1}' }, { name: "overrides/" }]);
    expect((await listZip(file)).map((e) => e.name)).toEqual(["manifest.json", "overrides/"]);
    expect((await readZipEntry(file, "manifest.json"))?.toString()).toBe('{"a":1}');
    expect(await readZipEntry(file, "missing.json")).toBeNull();
  });
});
