import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { silentLog, tmpDir } from "../../../test/helpers/tmp";
import type { ServerInstance } from "../../shared/model";
import type { ServerState } from "../../shared/servers";
import { listZip } from "../core/archive";
import { BackupService, excludedFromBackup } from "./backup-service";

function setup(opts: { confirmSave?: boolean } = {}) {
  const root = tmpDir();
  const dir = path.join(root, "servers", "Survival");
  const write = (rel: string, data: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };
  write("world/level.dat", "level-v1");
  write("world/region/r.0.0.mca", "region-v1");
  write("world/session.lock", "lock");
  write("mods/lithium.jar", "jar");
  write("config/lithium.properties", "a=1");
  write("server.properties", "motd=hi");
  write("server.jar", "server software");
  write("libraries/net/forge.jar", "lib");
  write("logs/latest.log", "log");
  write(".nexcraft/mod-sources.json", "{}");
  write(".nexcraft/mod-history/x/entry.json", "{}");

  let server = {
    id: "s1",
    name: "My Survival",
    directory: dir,
    minecraftVersion: "1.21.1",
    type: "fabric",
    loaderVersion: "0.16.10",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastBackupAt: null,
    backupSchedule: { everyHours: null, keep: 10 },
  } as unknown as ServerInstance;
  let state: ServerState = "stopped";
  const commands: string[] = [];
  let clock = Date.parse("2026-10-25T10:00:00.000Z");
  const svc = new BackupService({
    state: {
      server: (id) => (id === server.id ? structuredClone(server) : null),
      servers: () => [structuredClone(server)],
      upsertServer: (s) => {
        server = s;
      },
    },
    servers: {
      status: () => ({ state }) as never,
      commandAndWait: async (_id: string, command: string) => {
        commands.push(command);
        return command === "save-all flush" ? (opts.confirmSave ?? true) : true;
      },
    },
    backupsDir: () => path.join(root, "backups"),
    log: silentLog,
    now: () => new Date((clock += 60_000)),
  });
  return { svc, dir, write, root, commands, setState: (s: ServerState) => (state = s), server: () => server, read: (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8") };
}

describe("excludedFromBackup", () => {
  it("leaves out server software, logs, locks and NexCraft's own scratch folders", () => {
    expect(excludedFromBackup("libraries", true)).toBe(true);
    expect(excludedFromBackup("logs", true)).toBe(true);
    expect(excludedFromBackup("server.jar", false)).toBe(true);
    expect(excludedFromBackup("world/session.lock", false)).toBe(true);
    expect(excludedFromBackup(".nexcraft/mod-history", true)).toBe(true);
    expect(excludedFromBackup("mods/lithium.jar", false)).toBe(false);
    expect(excludedFromBackup("world/libraries", true)).toBe(false);
  });
});

describe("BackupService.create", () => {
  it("writes and verifies an archive of the server's data", async () => {
    const { svc, server } = setup();
    const info = await svc.create("s1", { kind: "manual", note: "before update" });
    expect(info).toMatchObject({ verified: true, kind: "manual", note: "before update", files: 6, savedWhileRunning: false });
    const names = (await listZip(svc.archivePath("s1", info.id))).map((e) => e.name).sort();
    expect(names).toEqual([
      ".nexcraft/mod-sources.json",
      "config/lithium.properties",
      "mods/lithium.jar",
      "nexcraft-backup.json",
      "server.properties",
      "world/level.dat",
      "world/region/r.0.0.mca",
    ]);
    expect(server().lastBackupAt).toBe(info.createdAt);
    expect(svc.list("s1").map((b) => b.id)).toEqual([info.id]);
    expect(info.id).toMatch(/^My-Survival-2026-10-25T10-01-00-000Z$/);
  });

  it("pauses saving and flushes the world on a running server", async () => {
    const { svc, commands, setState } = setup();
    setState("running");
    const info = await svc.create("s1", { kind: "manual" });
    expect(commands).toEqual(["save-off", "save-all flush", "save-on"]);
    expect(info.savedWhileRunning).toBe(true);
  });

  it("takes no backup when the server does not confirm the save, and turns saving back on", async () => {
    const { svc, commands, setState, root } = setup({ confirmSave: false });
    setState("running");
    await expect(svc.create("s1", { kind: "manual" })).rejects.toThrow(/did not confirm/);
    expect(commands).toEqual(["save-off", "save-all flush", "save-on"]);
    expect(fs.readdirSync(path.join(root, "backups", "s1"))).toEqual([]);
  });

  it("forgets interrupted archives", async () => {
    const { svc, root } = setup();
    fs.mkdirSync(path.join(root, "backups", "s1"), { recursive: true });
    fs.writeFileSync(path.join(root, "backups", "s1", "x.zip.partial"), "half");
    expect(svc.list("s1")).toEqual([]);
    expect(fs.readdirSync(path.join(root, "backups", "s1"))).toEqual([]);
  });
});

describe("retention and schedule", () => {
  it("keeps the newest scheduled backups and never trims manual ones", async () => {
    const { svc } = setup();
    svc.setSchedule("s1", { everyHours: 6, keep: 2 });
    const manual = await svc.create("s1", { kind: "manual" });
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await svc.create("s1", { kind: "scheduled" }));
    const left = svc.list("s1").map((b) => b.id);
    expect(left).toEqual([made[3].id, made[2].id, manual.id]);
  });

  it("runs a backup when one is due", async () => {
    const { svc, server } = setup();
    svc.setSchedule("s1", { everyHours: 1, keep: 5 });
    await svc.runDue();
    expect(svc.list("s1")[0]?.kind).toBe("scheduled");
    const after = server().lastBackupAt;
    await svc.runDue();
    expect(svc.list("s1")).toHaveLength(1);
    expect(server().lastBackupAt).toBe(after);
  });
});

describe("restore", () => {
  it("previews, then swaps the backup's items in after a safety backup", async () => {
    const { svc, write, read, dir } = setup();
    const backup = await svc.create("s1", { kind: "manual" });
    write("world/level.dat", "level-v2");
    write("world/region/r.1.0.mca", "new region");
    write("plugins-notes.txt", "mine");

    const preview = await svc.preview("s1", backup.id);
    expect(preview.replaces).toEqual([".nexcraft", "config", "mods", "server.properties", "world"]);
    expect(preview.keeps).toEqual(["plugins-notes.txt"]);
    expect(preview.warnings).toEqual([]);

    const { safetyBackupId } = await svc.restore("s1", backup.id);
    expect(read("world/level.dat")).toBe("level-v1");
    expect(fs.existsSync(path.join(dir, "world/region/r.1.0.mca"))).toBe(false);
    expect(read("plugins-notes.txt")).toBe("mine");
    expect(read("server.jar")).toBe("server software");
    // Mod history is NexCraft's own record; restoring does not wipe it.
    expect(fs.existsSync(path.join(dir, ".nexcraft/mod-history/x/entry.json"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, ".nexcraft")).some((n) => n.startsWith("restore-"))).toBe(false);

    const safety = svc.list("s1").find((b) => b.id === safetyBackupId)!;
    expect(safety.kind).toBe("safety");
    await svc.restore("s1", safetyBackupId);
    expect(read("world/level.dat")).toBe("level-v2");
  });

  it("refuses while the server runs, and leaves everything alone for a damaged archive", async () => {
    const { svc, setState, read } = setup();
    const backup = await svc.create("s1", { kind: "manual" });
    setState("running");
    await expect(svc.restore("s1", backup.id)).rejects.toThrow(/Stop My Survival/);
    setState("stopped");

    const zip = svc.archivePath("s1", backup.id);
    const bytes = fs.readFileSync(zip);
    // Region files are stored uncompressed, so their bytes can be found and damaged directly.
    const at = bytes.indexOf(Buffer.from("region-v1"));
    bytes.write("REGION-XX", at);
    fs.writeFileSync(zip, bytes);
    await expect(svc.restore("s1", backup.id)).rejects.toThrow(/damaged/);
    expect(read("world/level.dat")).toBe("level-v1");
    expect(svc.list("s1").filter((b) => b.kind === "safety")).toEqual([]);
  });

  it("warns when the backup is from another Minecraft version", async () => {
    const { svc, server } = setup();
    const backup = await svc.create("s1", { kind: "manual" });
    const s = server();
    (s as { minecraftVersion: string }).minecraftVersion = "1.20.1";
    const preview = await svc.preview("s1", backup.id);
    expect(preview.warnings[0]).toMatch(/made on Minecraft 1.21.1/);
  });
});
