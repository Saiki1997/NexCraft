import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../../../test/helpers/tmp";
import { PORTABLE_MARKER, resolveDataDir } from "./data-dir";

describe("resolveDataDir", () => {
  it("uses <exe folder>/data when the portable marker exists", () => {
    const exeDir = tmpDir();
    fs.writeFileSync(path.join(exeDir, PORTABLE_MARKER), "");
    const r = resolveDataDir({ exeDir, userDataDir: path.join(tmpDir(), "ud"), isPackaged: true, devDir: "unused" });
    expect(r).toEqual({ dataDir: path.join(exeDir, "data"), portable: true, warning: null });
    expect(fs.existsSync(r.dataDir)).toBe(true);
  });

  it("uses the user profile without the marker", () => {
    const ud = path.join(tmpDir(), "ud");
    const r = resolveDataDir({ exeDir: tmpDir(), userDataDir: ud, isPackaged: true, devDir: "unused" });
    expect(r).toEqual({ dataDir: ud, portable: false, warning: null });
  });

  it("falls back to the user profile with a warning when the app folder is read-only", () => {
    const exeDir = tmpDir();
    fs.writeFileSync(path.join(exeDir, PORTABLE_MARKER), "");
    const ud = path.join(tmpDir(), "ud");
    const fakeFs = {
      existsSync: fs.existsSync,
      mkdirSync: ((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
        if (String(p).startsWith(exeDir)) throw new Error("EPERM: operation not permitted");
        return fs.mkdirSync(p, o);
      }) as typeof fs.mkdirSync,
      accessSync: fs.accessSync,
    };
    const r = resolveDataDir({ exeDir, userDataDir: ud, isPackaged: true, devDir: "unused" }, fakeFs);
    expect(r.portable).toBe(false);
    expect(r.dataDir).toBe(ud);
    expect(r.warning).toMatch(/not writable/);
  });

  it("uses the dev folder for unpackaged runs", () => {
    const dev = path.join(tmpDir(), "data");
    expect(resolveDataDir({ exeDir: "x", userDataDir: "y", isPackaged: false, devDir: dev }).dataDir).toBe(dev);
  });
});
