/**
 * CPU and memory of one process we started, sampled without native modules:
 * PowerShell's Get-Process on Windows, /proc on Linux. CPU is a percentage of
 * the whole machine, like Task Manager.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export interface ProcessSample {
  cpuSeconds: number;
  rssBytes: number;
}

export async function sampleProcess(pid: number, platform: NodeJS.Platform = process.platform): Promise<ProcessSample | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    const out = await new Promise<string>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { '{0},{1}' -f $p.CPU, $p.WorkingSet64 }`],
        { windowsHide: true, timeout: 5000 },
        (err, stdout) => resolve(err ? "" : String(stdout)),
      );
    });
    const [cpu, rss] = out.trim().split(",").map(Number);
    return Number.isFinite(cpu) ? { cpuSeconds: cpu, rssBytes: rss || 0 } : null;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    const rssPages = Number(fields[21]);
    return { cpuSeconds: ticks / 100, rssBytes: rssPages * 4096 };
  } catch {
    return null;
  }
}

export class CpuMeter {
  private last = new Map<string, { cpu: number; at: number }>();

  percent(id: string, sample: ProcessSample, now = Date.now(), cores = os.cpus().length): number | null {
    const prev = this.last.get(id);
    this.last.set(id, { cpu: sample.cpuSeconds, at: now });
    if (!prev || now <= prev.at) return null;
    const pct = ((sample.cpuSeconds - prev.cpu) / ((now - prev.at) / 1000) / cores) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  forget(id: string) {
    this.last.delete(id);
  }
}
