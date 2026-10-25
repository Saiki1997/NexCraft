import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { silentLog, tmpDir } from "../../../test/helpers/tmp";
import { MAX_FINISHED_JOBS, type Job } from "../../shared/model";
import { StateService, type SecretSealer } from "./state-service";

const sealer: SecretSealer = {
  available: () => true,
  seal: (p) => Buffer.from(`sealed:${p}`).toString("base64"),
  unseal: (s) => Buffer.from(s, "base64").toString().replace(/^sealed:/, ""),
};

function job(id: string, status: Job["status"], createdAt = new Date().toISOString()): Job {
  return { id, kind: "download", title: id, status, serverId: null, createdAt, updatedAt: createdAt, progress: null, bytesDone: 0, bytesTotal: null, error: null, resumable: true };
}

describe("StateService", () => {
  it("persists settings across restarts", () => {
    const dir = tmpDir();
    const a = new StateService(dir, sealer, silentLog, 0);
    a.updateSettings({ theme: "light", maxParallelDownloads: 5 });
    a.saveNow();
    const b = new StateService(dir, sealer, silentLog, 0);
    expect(b.settingsView()).toMatchObject({ theme: "light", maxParallelDownloads: 5 });
  });

  it("stores the CurseForge key sealed and never exposes it in the settings view", () => {
    const dir = tmpDir();
    const s = new StateService(dir, sealer, silentLog, 0);
    const view = s.setCurseforgeKey("my-secret-key");
    s.saveNow();
    expect(view.hasCurseforgeKeyOverride).toBe(true);
    expect(JSON.stringify(view)).not.toContain("my-secret-key");
    expect(fs.readFileSync(path.join(dir, "nexcraft-state.json"), "utf8")).not.toContain("my-secret-key");
    expect(new StateService(dir, sealer, silentLog, 0).curseforgeKeyOverride()).toBe("my-secret-key");
    s.setCurseforgeKey(null);
    expect(s.curseforgeKeyOverride()).toBeNull();
  });

  it("refuses to save a key when secure storage is unavailable", () => {
    const s = new StateService(tmpDir(), { ...sealer, available: () => false }, silentLog, 0);
    expect(() => s.setCurseforgeKey("k")).toThrow(/secure storage/);
  });

  it("marks jobs that were running at the last shutdown as interrupted", () => {
    const dir = tmpDir();
    const a = new StateService(dir, sealer, silentLog, 0);
    a.recordJobs([job("done", "succeeded"), job("mid", "running"), job("wait", "queued")]);
    a.saveNow();
    const b = new StateService(dir, sealer, silentLog, 0);
    const byId = Object.fromEntries(b.jobs().map((j) => [j.id, j.status]));
    expect(byId).toEqual({ done: "succeeded", mid: "interrupted", wait: "interrupted" });
  });

  it("caps finished job history but never drops active jobs", () => {
    const s = new StateService(tmpDir(), sealer, silentLog, 0);
    const many = Array.from({ length: MAX_FINISHED_JOBS + 50 }, (_, i) => job(`j${i}`, "succeeded", new Date(2026, 0, 1, 0, 0, i).toISOString()));
    s.recordJobs([...many, job("active", "running", new Date(2025, 0, 1).toISOString())]);
    const jobs = s.jobs();
    expect(jobs.filter((j) => j.status === "succeeded")).toHaveLength(MAX_FINISHED_JOBS);
    expect(jobs.some((j) => j.id === "active")).toBe(true);
    expect(jobs.some((j) => j.id === "j0")).toBe(false);
  });

  it("recovers from a corrupt state file and reports it", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "nexcraft-state.json"), "garbage");
    const s = new StateService(dir, sealer, silentLog, 0);
    expect(s.loadResult.source).toBe("defaults");
    expect(s.loadResult.problem).toMatch(/not valid JSON/);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("nexcraft-state.json.corrupt-"))).toBe(true);
  });
});
