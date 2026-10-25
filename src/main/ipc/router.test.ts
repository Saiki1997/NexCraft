import { describe, expect, it } from "vitest";
import { silentLog } from "../../../test/helpers/tmp";
import type { EventName } from "../../shared/ipc";
import { dispatch, registerIpc, type Handlers } from "./router";

const trusted = (url: string) => url === "file:///app/index.html";

const handlers = {
  "settings:update": (patch: unknown) => ({ echoed: patch }),
  "jobs:cancel": () => {
    throw new Error("boom");
  },
} as unknown as Handlers;

describe("IPC dispatch", () => {
  it("runs the handler for a trusted sender with valid input", async () => {
    const r = await dispatch("settings:update", handlers, { maxParallelDownloads: 4 }, "file:///app/index.html", trusted, silentLog);
    expect(r).toEqual({ ok: true, value: { echoed: { maxParallelDownloads: 4 } } });
  });

  it("blocks calls from any other page", async () => {
    const r = await dispatch("settings:update", handlers, {}, "https://evil.example/", trusted, silentLog);
    expect(r).toMatchObject({ ok: false, error: "Not allowed" });
  });

  it("rejects input that does not match the schema, including unknown keys", async () => {
    const tooMany = await dispatch("settings:update", handlers, { maxParallelDownloads: 99 }, "file:///app/index.html", trusted, silentLog);
    expect(tooMany).toMatchObject({ ok: false, code: "invalid-input" });
    const extra = await dispatch("settings:update", handlers, { curseforgeKeyOverride: { sealed: "x" } }, "file:///app/index.html", trusted, silentLog);
    expect(extra).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("turns handler exceptions into error results", async () => {
    const r = await dispatch("jobs:cancel", handlers, { id: "x" }, "file:///app/index.html", trusted, silentLog);
    expect(r).toEqual({ ok: false, code: "failed", error: "boom" });
  });

  it("registers exactly the channels in the contract", () => {
    const names: string[] = [];
    registerIpc({ handle: (name) => names.push(name) }, handlers, trusted, silentLog);
    expect(names).toContain("app:info");
    expect(names).not.toContain("shell:exec");
    expect(names.every((n) => /^[a-z]+:[a-z-]+$/.test(n))).toBe(true);
  });
});

describe("settings patch schema", () => {
  it("only carries the fields that were sent, so one change cannot reset the others", async () => {
    const { SettingsPatchSchema } = await import("../../shared/ipc");
    expect(SettingsPatchSchema.parse({ theme: "light" })).toEqual({ theme: "light" });
  });
});

describe("folder settings", () => {
  it("accept absolute paths or empty, and refuse relative ones", async () => {
    const { SettingsPatchSchema } = await import("../../shared/ipc");
    expect(SettingsPatchSchema.safeParse({ serversDir: "D:\\Minecraft" }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ serversDir: "\\\\nas\\mc" }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ serversDir: "" }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ serversDir: "..\\elsewhere" }).success).toBe(false);
  });
});

describe("preload name lists", () => {
  it("match the IPC contract exactly", async () => {
    const { channels } = await import("../../shared/ipc");
    const { CHANNEL_NAMES, EVENT_NAMES } = await import("../../shared/ipc-names");
    expect([...CHANNEL_NAMES].sort()).toEqual(Object.keys(channels).sort());
    // Listing every event here makes the compiler flag a missing or misspelled one.
    const events: Record<EventName, true> = {
      "jobs:changed": true,
      "log:entry": true,
      "server:status": true,
      "server:console": true,
      "server:install": true,
      "java:changed": true,
    };
    expect([...EVENT_NAMES].sort()).toEqual(Object.keys(events).sort());
  });
});
