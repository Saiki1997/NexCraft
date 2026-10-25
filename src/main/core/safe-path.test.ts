import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInside, resolveInside, toSafeName, UnsafePathError } from "./safe-path";

const root = path.resolve("/srv/nexcraft/server-1");

describe("resolveInside", () => {
  it("resolves normal archive entries inside the root", () => {
    expect(resolveInside(root, "overrides/config/foo.toml")).toBe(path.join(root, "overrides", "config", "foo.toml"));
    expect(resolveInside(root, "mods\\a.jar")).toBe(path.join(root, "mods", "a.jar"));
    expect(resolveInside(root, "./mods/./b.jar")).toBe(path.join(root, "mods", "b.jar"));
  });

  it.each([
    ["../evil.jar"],
    ["mods/../../evil.jar"],
    ["..\\..\\Windows\\System32\\evil.dll"],
    ["/etc/passwd"],
    ["C:\\Windows\\evil.dll"],
    ["c:evil"],
    ["//server/share/x"],
    ["mods/CON"],
    ["mods/nul.txt"],
    ["mods/a\0.jar"],
    ["mods/what?.jar"],
    ["mods/trailing."],
    [""],
    ["./"],
  ])("refuses %j", (entry) => {
    expect(() => resolveInside(root, entry)).toThrow(UnsafePathError);
  });
});

describe("isInside", () => {
  it("accepts the root and children, refuses siblings with a shared prefix", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, "world"))).toBe(true);
    expect(isInside(root, `${root}-evil`)).toBe(false);
    expect(isInside(root, path.dirname(root))).toBe(false);
  });
});

describe("toSafeName", () => {
  it("cleans names for use as folder names", () => {
    expect(toSafeName("My: Server/1")).toBe("My- Server-1");
    expect(toSafeName("  spaced   out  ")).toBe("spaced out");
    expect(toSafeName("CON")).toBe("untitled");
    expect(toSafeName("dots...")).toBe("dots");
    expect(toSafeName("x".repeat(100))).toHaveLength(64);
  });
});
