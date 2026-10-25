import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../../../test/helpers/tmp";
import { Logger } from "./logger";

const CF_KEY = "$2a$10$" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0".slice(0, 53);

describe("Logger", () => {
  it("redacts registered secrets and known credential shapes in memory and on disk", () => {
    const dir = tmpDir();
    const logger = new Logger(dir, "debug", 100, () => new Date("2026-10-25T10:00:00Z"));
    logger.addSecret("hunter2-password");
    const log = logger.scope("test");
    log.info(`key=${CF_KEY} and pass hunter2-password`);
    log.info("rcon.password=supersecret");
    log.info("x-api-key: abc123");

    const messages = logger.recent(10).map((e) => e.message);
    expect(messages.join("\n")).not.toContain("hunter2-password");
    expect(messages.join("\n")).not.toContain(CF_KEY);
    expect(messages[1]).toBe("rcon.password=***");
    expect(messages[2]).toBe("x-api-key: ***");

    const file = fs.readFileSync(path.join(dir, "nexcraft-2026-10-25.log"), "utf8");
    expect(file).not.toContain("supersecret");
    expect(file).not.toContain(CF_KEY);
  });

  it("respects the minimum level and the buffer size", () => {
    const logger = new Logger(null, "info", 3);
    const log = logger.scope("t");
    log.debug("hidden");
    for (let i = 0; i < 5; i++) log.info(`m${i}`);
    expect(logger.recent(10).map((e) => e.message)).toEqual(["m2", "m3", "m4"]);
  });

  it("prunes only its own old log files", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "nexcraft-2026-01-01.log"), "old");
    fs.writeFileSync(path.join(dir, "nexcraft-2026-10-24.log"), "recent");
    fs.writeFileSync(path.join(dir, "someone-else.log"), "keep");
    new Logger(dir, "info", 10, () => new Date("2026-10-25T00:00:00Z")).prune(14);
    expect(fs.readdirSync(dir).sort()).toEqual(["nexcraft-2026-10-24.log", "someone-else.log"]);
  });
});
