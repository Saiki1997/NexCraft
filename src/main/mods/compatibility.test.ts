import { describe, expect, it } from "vitest";
import { assessMods, type ModFacts, type ServerTarget } from "./compatibility";
import type { ModMetadata } from "./mod-metadata";

const fabric: ServerTarget = { loader: "fabric", minecraftVersion: "1.21.1", loaderVersion: "0.16.10" };

function meta(id: string, patch: Partial<ModMetadata> = {}): ModMetadata {
  return { id, name: id, version: "1.0.0", loaders: ["fabric", "quilt"], environment: "both", dependencies: [], provides: [], ...patch };
}
function mod(file: string, m: ModMetadata | null, patch: Partial<ModFacts> = {}): ModFacts {
  return { file, enabled: true, meta: m, provider: null, ...patch };
}

describe("assessMods", () => {
  it("confirms mods the provider lists for this exact version and loader", () => {
    const [a] = assessMods(fabric, [mod("lithium.jar", meta("lithium"), { provider: { name: "Modrinth", gameVersions: ["1.21", "1.21.1"], loaders: ["fabric"] } })]);
    expect(a.label).toBe("confirmed");
  });

  it("falls back to metadata, then unknown", () => {
    const [m, u] = assessMods(fabric, [
      mod("a.jar", meta("a", { dependencies: [{ id: "minecraft", range: ">=1.21", kind: "required" }] })),
      mod("lib.jar", null),
    ]);
    expect(m.label).toBe("metadata");
    expect(u.label).toBe("unknown");
  });

  it("marks client-only, wrong-loader and wrong-Minecraft mods incompatible", () => {
    const res = assessMods(fabric, [
      mod("sodium.jar", meta("sodium", { environment: "client" })),
      mod("create.jar", meta("create", { loaders: ["neoforge"] })),
      mod("old.jar", meta("old", { dependencies: [{ id: "minecraft", range: "~1.20.4", kind: "required" }] })),
      mod("newloader.jar", meta("nl", { dependencies: [{ id: "loader", range: ">=0.17", kind: "required" }] })),
    ]);
    expect(res.map((r) => r.label)).toEqual(["incompatible", "incompatible", "incompatible", "incompatible"]);
    expect(res[1].reasons[0]).toContain("NeoForge mod");
    expect(res[2].reasons[0]).toContain("Needs Minecraft ~1.20.4");
  });

  it("lets Quilt servers run Fabric mods but not the other way round", () => {
    const quiltOnly = meta("qsl", { loaders: ["quilt"] });
    expect(assessMods({ ...fabric, loader: "quilt" }, [mod("x.jar", meta("x"))])[0].label).toBe("metadata");
    expect(assessMods(fabric, [mod("q.jar", quiltOnly)])[0].label).toBe("incompatible");
  });

  it("flags missing, switched-off and mismatched dependencies as suspected conflicts", () => {
    const needsApi = meta("needs", { dependencies: [{ id: "fabric-api", range: "*", kind: "required" }, { id: "cloth-config", range: ">=15", kind: "required" }] });
    const res = assessMods(fabric, [mod("needs.jar", needsApi), mod("cloth.jar", meta("cloth-config", { version: "14.0.0" }))]);
    expect(res[0].label).toBe("conflict");
    expect(res[0].reasons).toEqual(["Needs fabric-api, which is not installed.", "Needs cloth-config >=15; version 14.0.0 is installed."]);

    const off = assessMods(fabric, [mod("needs.jar", meta("n", { dependencies: [{ id: "fabric-api", range: "*", kind: "required" }] })), mod("api.jar", meta("fabric-api", { name: "Fabric API" }), { enabled: false })]);
    expect(off[0].reasons).toEqual(["Needs Fabric API, which is switched off."]);
  });

  it("treats ids a jar bundles or provides as installed", () => {
    const res = assessMods(fabric, [
      mod("needs.jar", meta("n", { dependencies: [{ id: "fabric-api-base", range: "*", kind: "required" }, { id: "fabric", range: "*", kind: "required" }] })),
      mod("api.jar", meta("fabric-api", { provides: ["fabric-api-base"] })),
    ]);
    expect(res[0].label).toBe("metadata");
  });

  it("reports declared incompatibilities in both directions, and duplicates", () => {
    const res = assessMods(fabric, [
      mod("a.jar", meta("a", { dependencies: [{ id: "b", range: "*", kind: "incompatible" }] })),
      mod("b.jar", meta("b")),
      mod("b2.jar", meta("b")),
    ]);
    expect(res[0].label).toBe("incompatible");
    expect(res[1].reasons).toContain("a says it does not work with this mod.");
    expect(res[1].reasons).toContain("Installed twice; b2.jar is the same mod.");
  });

  it("reports what the provider says when it disagrees", () => {
    const forgeFile = { name: "Modrinth", gameVersions: ["1.21.1"], loaders: ["forge"] };
    expect(assessMods(fabric, [mod("x.jar", null, { provider: forgeFile })])[0]).toEqual({ label: "incompatible", reasons: ["Modrinth lists this file for Forge, not Fabric."] });
    const otherMc = { name: "Modrinth", gameVersions: ["1.21"], loaders: ["fabric"] };
    expect(assessMods(fabric, [mod("x.jar", null, { provider: otherMc })])[0].label).toBe("conflict");
    const saysOk = meta("x", { dependencies: [{ id: "minecraft", range: ">=1.21", kind: "required" }] });
    expect(assessMods(fabric, [mod("x.jar", saysOk, { provider: otherMc })])[0].label).toBe("metadata");
  });
});
