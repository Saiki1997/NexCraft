import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessHost, type ExitInfo, type OutputLine } from "./process-host";

const script = path.resolve(__dirname, "../../../test/helpers/fake-server.cjs");

function host() {
  const h = new ProcessHost();
  const lines: OutputLine[] = [];
  const exits: ExitInfo[] = [];
  h.on("output", (l) => lines.push(l));
  h.on("exit", (e) => exits.push(e));
  return { h, lines, exits };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("ProcessHost", () => {
  it("streams stdout and stderr as whole lines and accepts console commands", async () => {
    const { h, lines } = host();
    await h.start("s1", { executable: process.execPath, args: [script], cwd: path.dirname(script) });
    expect(h.isRunning("s1")).toBe(true);
    expect(h.pid("s1")).toBeGreaterThan(0);
    await waitFor(() => lines.some((l) => l.text === "partial line without newline then its end"));
    expect(lines.some((l) => l.stream === "stderr" && l.text === "a warning on stderr")).toBe(true);

    expect(h.send("s1", "list\nop attacker")).toBe(true);
    await waitFor(() => lines.some((l) => l.text === "> list op attacker"));
    expect(h.send("s1", "   ")).toBe(false);
    await h.forceKill("s1");
  });

  it("stops gracefully by sending stop and waiting for a clean exit", async () => {
    const { h, lines, exits } = host();
    await h.start("s2", { executable: process.execPath, args: [script], cwd: path.dirname(script) });
    const result = await h.stop("s2", { timeoutMs: 5000 });
    expect(result).toBe("stopped");
    expect(lines.some((l) => l.text === "Saving worlds")).toBe(true);
    await waitFor(() => exits.length === 1);
    expect(exits[0]).toMatchObject({ id: "s2", code: 0, requested: true });
    expect(h.isRunning("s2")).toBe(false);
  });

  it("reports a timeout instead of force-killing on its own", async () => {
    const { h } = host();
    await h.start("s3", { executable: process.execPath, args: [script, "--ignore-stop"], cwd: path.dirname(script) });
    expect(await h.stop("s3", { timeoutMs: 300 })).toBe("timeout");
    expect(h.isRunning("s3")).toBe(true);
    expect(await h.forceKill("s3")).toBe(true);
    expect(h.isRunning("s3")).toBe(false);
  });

  it("marks exits NexCraft did not ask for as unrequested", async () => {
    const { h, exits } = host();
    await h.start("s4", { executable: process.execPath, args: ["-e", "process.exit(3)"], cwd: process.cwd() });
    await waitFor(() => exits.length === 1);
    expect(exits[0]).toMatchObject({ code: 3, requested: false });
  });

  it("refuses to start the same server twice and rejects a missing executable", async () => {
    const { h } = host();
    await h.start("s5", { executable: process.execPath, args: [script], cwd: path.dirname(script) });
    await expect(h.start("s5", { executable: process.execPath, args: [script], cwd: path.dirname(script) })).rejects.toThrow(/already running/);
    await h.forceKill("s5");
    await expect(h.start("s6", { executable: path.join(path.dirname(script), "no-such-java.exe"), args: [], cwd: process.cwd() })).rejects.toThrow();
    expect(h.isRunning("s6")).toBe(false);
  });

  it("returns not-running for unknown ids", async () => {
    const { h } = host();
    expect(await h.stop("nope")).toBe("not-running");
    expect(await h.forceKill("nope")).toBe(false);
  });
});
