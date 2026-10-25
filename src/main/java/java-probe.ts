/**
 * Ask a Java executable what it is. Runs `java -XshowSettings:properties -version`
 * (no shell, short timeout) and parses the properties it prints.
 */
import { execFile } from "node:child_process";

export interface JavaProbe {
  executable: string;
  version: string;
  major: number;
  vendor: string;
  arch: "x64" | "x86" | "arm64" | "unknown";
  home: string;
}

export function parseJavaMajor(version: string): number | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!m) return null;
  const first = Number(m[1]);
  // Java 8 and older report "1.8.0_402".
  if (first === 1 && m[2]) return Number(m[2]);
  return first;
}

export function parseJavaProperties(output: string): Omit<JavaProbe, "executable"> | null {
  const props: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+([\w.]+) = (.*)$/.exec(line);
    if (m) props[m[1]] = m[2].trim();
  }
  let version = props["java.version"];
  if (!version) {
    // Fallback: `openjdk version "21.0.5" 2024-10-15`
    version = /version "([^"]+)"/.exec(output)?.[1] ?? "";
  }
  const major = parseJavaMajor(version);
  if (!major) return null;
  const rawArch = (props["os.arch"] ?? "").toLowerCase();
  const arch = rawArch === "amd64" || rawArch === "x86_64" ? "x64" : rawArch === "aarch64" || rawArch === "arm64" ? "arm64" : rawArch === "x86" || rawArch === "i386" ? "x86" : "unknown";
  return {
    version,
    major,
    vendor: props["java.vendor"] ?? props["java.vm.vendor"] ?? "",
    arch,
    home: props["java.home"] ?? "",
  };
}

export type ExecFn = (file: string, args: string[], opts: { timeout: number; windowsHide: boolean }) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, maxBuffer: 1024 * 1024, env: { ...process.env, JAVA_TOOL_OPTIONS: "" } }, (err, stdout, stderr) => {
      if (err && !stderr) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export async function probeJava(executable: string, exec: ExecFn = defaultExec): Promise<JavaProbe> {
  const { stdout, stderr } = await exec(executable, ["-XshowSettings:properties", "-version"], { timeout: 15_000, windowsHide: true });
  const parsed = parseJavaProperties(`${stderr}\n${stdout}`);
  if (!parsed) throw new Error(`${executable} did not report a Java version`);
  return { executable, ...parsed };
}
