import { describe, expect, it } from "vitest";
import { JOIN_LINE, matchLine, READY_LINE, STOPPING_LINE } from "./log-rules";

describe("log rules", () => {
  it.each([
    ["[main/WARN]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.", "eula"],
    ["[Server thread/WARN]: **** FAILED TO BIND TO PORT!", "port-in-use"],
    ["Exception in thread \"main\" java.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0", "java-too-old"],
    ["Error occurred during initialization of VM: Could not reserve enough space for 8388608KB object heap", "heap-reserve"],
    ["java.lang.OutOfMemoryError: Java heap space", "out-of-memory"],
    ["Error: Invalid or corrupt jarfile server.jar", "corrupt-jar"],
    ["[Server thread/WARN]: Can't keep up! Is the server overloaded? Running 5003ms or 100 ticks behind", "cant-keep-up"],
    ["[Server thread/WARN]: **** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!", "offline-mode"],
    ["java.lang.RuntimeException: Attempted to load class net/minecraft/client/gui/Screen for invalid dist DEDICATED_SERVER", "client-only-mod"],
    ["net.fabricmc.loader.impl.FormattedException: Incompatible mods found!", "mod-dependencies"],
    ["Caused by: java.lang.IllegalArgumentException: Unsupported class file major version 69", "loader-too-old"],
    ["[main/ERROR]: Missing or unsupported mandatory dependencies:", "mod-dependencies"],
    ["org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: Mixin transformation of net.minecraft.X failed", "mixin-failure"],
  ])("recognises %s", (line, id) => {
    const f = matchLine(line);
    expect(f?.id).toBe(id);
    expect(f?.title).toBeTruthy();
    expect(f?.fix).toBeTruthy();
  });

  it("names the Java version a too-new class file needs", () => {
    const f = matchLine("java.lang.UnsupportedClassVersionError: Main has been compiled by a more recent version (class file version 65.0)");
    expect(`${f?.title} ${f?.explanation} ${f?.fix}`).toContain("21");
  });

  it("ignores ordinary lines", () => {
    expect(matchLine("[Server thread/INFO]: Preparing spawn area: 83%")).toBeNull();
  });

  it("parses the ready, stopping and join lines", () => {
    expect(READY_LINE.exec('[12:00:00] [Server thread/INFO]: Done (12.345s)! For help, type "help"')?.[1]).toBe("12.345");
    expect(STOPPING_LINE.test("[12:00:00] [Server thread/INFO]: Stopping the server")).toBe(true);
    expect(JOIN_LINE.exec("[12:00:00] [Server thread/INFO]: Steve_01 joined the game")?.[1]).toBe("Steve_01");
  });
});
