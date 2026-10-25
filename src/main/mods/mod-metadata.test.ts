import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../../../test/helpers/tmp";
import { buildZip, type FixtureEntry } from "../../../test/helpers/zip";
import { readModMetadata, versionMatches } from "./mod-metadata";

function jar(entries: FixtureEntry[]) {
  const file = path.join(tmpDir(), "mod.jar");
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

describe("readModMetadata", () => {
  it("reads Fabric mods, including client-only ones", async () => {
    const meta = await readModMetadata(
      jar([
        {
          name: "fabric.mod.json",
          data: JSON.stringify({ id: "sodium", name: "Sodium", version: "0.6.0", environment: "client", depends: { minecraft: ">=1.21", fabricloader: ">=0.16" }, breaks: { optifabric: "*" } }),
        },
      ]),
    );
    expect(meta).toMatchObject({ id: "sodium", name: "Sodium", environment: "client", loaders: ["fabric", "quilt"] });
    expect(meta?.dependencies).toEqual([
      { id: "minecraft", range: ">=1.21", kind: "required" },
      { id: "loader", range: ">=0.16", kind: "required" },
      { id: "optifabric", range: "*", kind: "incompatible" },
    ]);
    expect((await readModMetadata(jar([{ name: "fabric.mod.json", data: JSON.stringify({ id: "lithium", version: "1" }) }])))?.environment).toBe("both");
  });

  it("lists the mods a jar bundles or declares, so their ids count as installed", async () => {
    const nested = buildZip([{ name: "fabric.mod.json", data: JSON.stringify({ id: "fabric-api-base", version: "0.4.0" }) }]);
    const meta = await readModMetadata(
      jar([
        { name: "fabric.mod.json", data: JSON.stringify({ id: "fabric-api", version: "0.100.0", provides: ["fabric"], jars: [{ file: "META-INF/jars/base.jar" }, { file: "META-INF/jars/missing.jar" }] }) },
        { name: "META-INF/jars/base.jar", data: nested },
      ]),
    );
    expect(meta?.provides.sort()).toEqual(["fabric", "fabric-api-base"]);

    const forgeNested = buildZip([{ name: "META-INF/mods.toml", data: '[[mods]]\nmodId="mixinextras"\nversion="0.4.1"' }]);
    const forge = await readModMetadata(
      jar([
        { name: "META-INF/mods.toml", data: '[[mods]]\nmodId="create"\nversion="6.0.0"' },
        { name: "META-INF/jarjar/metadata.json", data: JSON.stringify({ jars: [{ path: "META-INF/jarjar/mixinextras.jar" }] }) },
        { name: "META-INF/jarjar/mixinextras.jar", data: forgeNested },
      ]),
    );
    expect(forge?.provides).toEqual(["mixinextras"]);
  });

  it("reads NeoForge and Forge mods.toml, with the version from the manifest", async () => {
    const toml = `
modLoader="javafml"
loaderVersion="[4,)"
[[mods]]
modId="create"
version="\${file.jarVersion}"
displayName="Create"
[[dependencies.create]]
modId="minecraft"
type="required"
versionRange="[1.21.1,1.21.2)"
side="BOTH"
[[dependencies.create]]
modId="flywheel"
type="required"
versionRange="[1.0,)"
`;
    const meta = await readModMetadata(
      jar([
        { name: "META-INF/neoforge.mods.toml", data: toml },
        { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\nImplementation-Version: 6.0.0\r\n" },
      ]),
    );
    expect(meta).toMatchObject({ id: "create", name: "Create", version: "6.0.0", loaders: ["neoforge"], environment: "unknown" });
    expect(meta?.dependencies.map((d) => d.id)).toEqual(["minecraft", "flywheel"]);
  });

  it("flags Forge mods that say they only run on the client", async () => {
    const toml = `clientSideOnly=true\n[[mods]]\nmodId="oculus"\nversion="1.0"\n`;
    expect((await readModMetadata(jar([{ name: "META-INF/mods.toml", data: toml }])))?.environment).toBe("client");
  });

  it("returns null for plain libraries", async () => {
    expect(await readModMetadata(jar([{ name: "com/example/A.class", data: "x" }]))).toBeNull();
  });
});

describe("versionMatches", () => {
  it.each([
    [">=1.21", "1.21.1", true],
    [">=1.21 <1.22", "1.22", false],
    ["~1.20.4", "1.20.6", true],
    ["~1.20.4", "1.21", false],
    ["1.21.x", "1.21.4", true],
    ["1.21.x", "1.20.4", false],
    ["1.20.1 || 1.21.1", "1.21.1", true],
    ["[1.21.1,1.21.2)", "1.21.1", true],
    ["[1.21.1,1.21.2)", "1.21.2", false],
    ["[1.20,)", "26.1", true],
    ["[1.20.1]", "1.20.1", true],
    ["*", "1.0", true],
  ])("%s with %s → %s", (range, version, expected) => {
    expect(versionMatches(range, version)).toBe(expected);
  });

  it("says it does not know when the range is unusual", () => {
    expect(versionMatches("some-weird thing", "1.21")).toBeNull();
  });
});
