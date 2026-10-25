import { describe, expect, it } from "vitest";
import { ServerProperties, validateProperties } from "./server-properties";

const SAMPLE = `#Minecraft server properties
#Fri Oct 24 12:00:00 UTC 2026
motd=Hello \\u00e9 world
server-port=25565
some-mod-key=keep me
online-mode=true
`;

describe("server.properties", () => {
  it("keeps comments, order and unknown keys when values change", () => {
    const p = ServerProperties.parse(SAMPLE);
    expect(p.get("motd")).toBe("Hello é world");
    p.setMany({ "server-port": "25570", "view-distance": "12" });
    const out = p.toString();
    expect(out.split("\n").slice(0, 2)).toEqual(["#Minecraft server properties", "#Fri Oct 24 12:00:00 UTC 2026"]);
    expect(out).toContain("some-mod-key=keep me");
    expect(out).toContain("server-port=25570");
    expect(out).toContain("motd=Hello \\u00e9 world");
    expect(out.trimEnd().endsWith("view-distance=12")).toBe(true);
    expect(ServerProperties.parse(out).entries()).toMatchObject({ "server-port": "25570", "some-mod-key": "keep me", motd: "Hello é world" });
  });

  it("round-trips awkward values", () => {
    const p = ServerProperties.fresh({ motd: " leading space and a \\ backslash", "level-seed": "-12345" });
    const back = ServerProperties.parse(p.toString());
    expect(back.get("motd")).toBe(" leading space and a \\ backslash");
    expect(back.get("level-seed")).toBe("-12345");
  });

  it("rejects invalid values and changes nothing", () => {
    const p = ServerProperties.parse(SAMPLE);
    expect(() => p.setMany({ "server-port": "70000", motd: "ok" })).toThrow(/server-port/);
    expect(p.get("motd")).toBe("Hello é world");
    expect(validateProperties({ "view-distance": "2" })[0].key).toBe("view-distance");
    expect(validateProperties({ "online-mode": "yes" })).toHaveLength(1);
    expect(validateProperties({ motd: "two\nlines" })).toHaveLength(1);
    expect(validateProperties({ "bad key": "x" })).toHaveLength(1);
    expect(validateProperties({ "level-name": "../escape" })).toHaveLength(1);
    expect(validateProperties({ "custom-key": "anything" })).toEqual([]);
  });
});
