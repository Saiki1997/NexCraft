import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { silentLog, tmpDir } from "../../../test/helpers/tmp";
import type { JavaRuntime } from "../../shared/model";
import { DownloadQueue } from "../core/download-queue";
import { candidateJavaPaths } from "./java-detect";
import { parseJavaMajor, parseJavaProperties, type ExecFn } from "./java-probe";
import { commonTopFolder, JavaService } from "./java-service";

const TEMURIN_21 = `Property settings:
    file.encoding = UTF-8
    java.home = C:\\Program Files\\Eclipse Adoptium\\jre-21.0.5.11-hotspot
    java.vendor = Eclipse Adoptium
    java.version = 21.0.5
    os.arch = amd64

openjdk version "21.0.5" 2024-10-15 LTS
`;
const JAVA_8 = `Property settings:
    java.vendor = Oracle Corporation
    java.version = 1.8.0_421
    os.arch = x86

java version "1.8.0_421"
`;

describe("Java probe parsing", () => {
  it("reads version, vendor and architecture", () => {
    expect(parseJavaProperties(TEMURIN_21)).toMatchObject({ major: 21, version: "21.0.5", vendor: "Eclipse Adoptium", arch: "x64" });
    expect(parseJavaProperties(JAVA_8)).toMatchObject({ major: 8, arch: "x86" });
    expect(parseJavaProperties('openjdk version "17.0.12" 2024-07-16')).toMatchObject({ major: 17 });
    expect(parseJavaProperties("garbage")).toBeNull();
  });

  it("parses major versions in both numbering schemes", () => {
    expect(parseJavaMajor("1.8.0_402")).toBe(8);
    expect(parseJavaMajor("11.0.2")).toBe(11);
    expect(parseJavaMajor("21")).toBe(21);
  });
});

describe("candidateJavaPaths", () => {
  it("finds Java in JAVA_HOME, PATH, vendor folders and Minecraft Launcher runtimes on Windows", () => {
    const files = new Set([
      "C:\\jdk17\\bin\\java.exe",
      "C:\\tools\\java.exe",
      "C:\\Program Files\\Eclipse Adoptium\\jre-21\\bin\\java.exe",
      "C:\\Program Files (x86)\\Minecraft Launcher\\runtime\\java-runtime-gamma\\windows-x64\\java-runtime-gamma\\bin\\java.exe",
      "D:\\nex\\java\\temurin-21\\bin\\java.exe",
    ]);
    const dirs: Record<string, string[]> = {
      "C:\\Program Files\\Eclipse Adoptium": ["jre-21"],
      "C:\\Program Files (x86)\\Minecraft Launcher\\runtime": ["java-runtime-gamma"],
      "C:\\Program Files (x86)\\Minecraft Launcher\\runtime\\java-runtime-gamma": ["windows-x64"],
      "C:\\Program Files (x86)\\Minecraft Launcher\\runtime\\java-runtime-gamma\\windows-x64": ["java-runtime-gamma"],
      "D:\\nex\\java": ["temurin-21"],
    };
    const fakeFs = {
      existsSync: (p: fs.PathLike) => files.has(String(p)),
      statSync: () => ({ isFile: () => true }),
      readdirSync: (p: fs.PathLike) => {
        const list = dirs[String(p)];
        if (!list) throw new Error("ENOENT");
        return list;
      },
    } as unknown as typeof fs;
    const found = candidateJavaPaths(
      {
        platform: "win32",
        env: { JAVA_HOME: "C:\\jdk17", PATH: "C:\\Windows;C:\\tools", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        managedDir: "D:\\nex\\java",
      },
      fakeFs,
    );
    expect(found.sort()).toEqual([...files].sort());
  });
});

function fakeExec(byPath: Record<string, string>): ExecFn {
  return async (file) => {
    const out = byPath[file];
    if (!out) throw new Error("ENOENT");
    return { stdout: "", stderr: out };
  };
}

function memoryState(initial: JavaRuntime[] = []) {
  let list = initial;
  return { javaRuntimes: () => structuredClone(list), setJavaRuntimes: (l: JavaRuntime[]) => (list = structuredClone(l)) };
}

describe("JavaService", () => {
  it("adds a custom runtime only after it runs, and refuses non-Java files", async () => {
    const svc = new JavaService({
      state: memoryState(),
      downloads: new DownloadQueue({ userAgent: "t" }),
      log: silentLog,
      javaDir: () => tmpDir(),
      userAgent: "t",
      platform: "win32",
      exec: fakeExec({ "C:\\jdk\\bin\\java.exe": TEMURIN_21 }),
    });
    await expect(svc.addCustom("C:\\Windows\\notepad.exe")).rejects.toThrow(/Choose a Java executable/);
    const rt = await svc.addCustom("C:\\jdk\\bin\\javaw.exe");
    expect(rt).toMatchObject({ executable: "C:\\jdk\\bin\\java.exe", major: 21, source: "custom" });
    await expect(svc.addCustom("C:\\broken\\bin\\java.exe")).rejects.toThrow();
  });

  it("picks an exact match first, prefers NexCraft-managed Java, and never picks one that is too old", () => {
    const rt = (id: string, major: number, source: JavaRuntime["source"]): JavaRuntime => ({
      id, executable: `/j/${id}`, major, version: String(major), vendor: "", arch: "x64", source, lastVerifiedAt: null,
    });
    const svc = new JavaService({
      state: memoryState([rt("a17", 17, "detected"), rt("b25", 25, "detected"), rt("c21", 21, "detected"), rt("d21", 21, "managed"), rt("e8", 8, "detected")]),
      downloads: new DownloadQueue({ userAgent: "t" }),
      log: silentLog,
      javaDir: () => "/j",
      userAgent: "t",
    });
    expect(svc.pickFor(21)?.id).toBe("d21");
    expect(svc.pickFor(17)?.id).toBe("a17");
    expect(svc.pickFor(8)?.id).toBe("e8");
    expect(svc.pickFor(22)?.id).toBe("b25");
    expect(svc.pickFor(26)).toBeNull();
    expect(svc.pickFor(21, "a17")?.id).toBe("d21");
  });

  it("detects runtimes, keeps custom ones, and drops detected ones that disappeared", async () => {
    const dir = tmpDir();
    const javaHome = path.join(dir, "jdk21");
    fs.mkdirSync(path.join(javaHome, "bin"), { recursive: true });
    const exe = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
    fs.writeFileSync(exe, "");
    const custom = path.join(dir, "custom-java");
    fs.writeFileSync(custom, "");
    const state = memoryState([
      { id: "gone", executable: path.join(dir, "missing", "java"), major: 17, version: "17", vendor: "", arch: "x64", source: "detected", lastVerifiedAt: null },
      { id: "mine", executable: custom, major: 17, version: "17", vendor: "", arch: "x64", source: "custom", lastVerifiedAt: null },
    ]);
    const svc = new JavaService({
      state,
      downloads: new DownloadQueue({ userAgent: "t" }),
      log: silentLog,
      javaDir: () => path.join(dir, "managed"),
      userAgent: "t",
      env: { JAVA_HOME: javaHome },
      exec: fakeExec({ [exe]: TEMURIN_21 }),
    });
    const list = await svc.detect();
    expect(list.map((r) => r.id).includes("gone")).toBe(false);
    expect(list.find((r) => r.id === "mine")).toBeTruthy();
    expect(list.find((r) => r.executable === exe)).toMatchObject({ major: 21, source: "detected" });
  });

  it("finds the single top folder of a JRE archive", () => {
    expect(commonTopFolder(["jdk-21.0.5+11-jre/", "jdk-21.0.5+11-jre/bin/java.exe"])).toBe("jdk-21.0.5+11-jre/");
    expect(commonTopFolder(["a/x", "b/y"])).toBeNull();
  });
});
