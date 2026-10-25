import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tmpDir } from "../../../test/helpers/tmp";
import { JsonStore } from "./json-store";

const Schema = z.object({ schemaVersion: z.literal(2), name: z.string(), count: z.number() });
type T = z.infer<typeof Schema>;

function makeStore(dir: string) {
  return new JsonStore<T>({
    file: path.join(dir, "state.json"),
    schema: Schema,
    currentVersion: 2,
    migrations: {
      0: (d) => ({ ...d, name: d.name ?? "unnamed" }),
      1: (d) => ({ ...d, count: Number(d.count ?? 0) }),
    },
    defaults: () => ({ schemaVersion: 2, name: "default", count: 0 }),
    now: () => new Date("2026-10-25T00:00:00Z"),
  });
}

describe("JsonStore", () => {
  it("returns defaults when nothing is stored", () => {
    const r = makeStore(tmpDir()).load();
    expect(r.source).toBe("defaults");
    expect(r.value.name).toBe("default");
  });

  it("round-trips data and keeps a backup of the previous good file", () => {
    const dir = tmpDir();
    const store = makeStore(dir);
    store.save({ schemaVersion: 2, name: "a", count: 1 });
    store.save({ schemaVersion: 2, name: "b", count: 2 });
    expect(store.load().value).toEqual({ schemaVersion: 2, name: "b", count: 2 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json.bak"), "utf8")).name).toBe("a");
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("runs migrations from an older schema", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ count: "7" }));
    const r = makeStore(dir).load();
    expect(r.source).toBe("file");
    expect(r.value).toEqual({ schemaVersion: 2, name: "unnamed", count: 7 });
  });

  it("quarantines a corrupt file and falls back to the backup", () => {
    const dir = tmpDir();
    const store = makeStore(dir);
    store.save({ schemaVersion: 2, name: "good", count: 1 });
    store.save({ schemaVersion: 2, name: "newer", count: 2 });
    fs.writeFileSync(path.join(dir, "state.json"), "{ not json");
    const r = store.load();
    expect(r.source).toBe("backup");
    expect(r.value.name).toBe("good");
    expect(r.problem).toMatch(/not valid JSON/);
    expect(r.quarantined).toBe(path.join(dir, "state.json.corrupt-2026-10-25T00-00-00-000Z"));
    expect(fs.readFileSync(r.quarantined!, "utf8")).toBe("{ not json");
  });

  it("falls back to defaults when the file fails validation and there is no backup", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ schemaVersion: 2, name: 5, count: 1 }));
    const r = makeStore(dir).load();
    expect(r.source).toBe("defaults");
    expect(r.problem).toMatch(/failed validation at name/);
  });

  it("refuses data written by a newer version instead of downgrading it", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ schemaVersion: 9, name: "future", count: 1 }));
    const r = makeStore(dir).load();
    expect(r.source).toBe("defaults");
    expect(r.problem).toMatch(/newer NexCraft/);
    expect(fs.existsSync(r.quarantined!)).toBe(true);
  });

  it("refuses to save invalid data", () => {
    const store = makeStore(tmpDir());
    expect(() => store.save({ schemaVersion: 2, name: "x", count: "nope" } as unknown as T)).toThrow();
  });
});
