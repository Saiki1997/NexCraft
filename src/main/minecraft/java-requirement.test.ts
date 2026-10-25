import { describe, expect, it } from "vitest";
import { fallbackJavaMajor, installableMajor, javaFit, javaMajorForClassVersion } from "./java-requirement";

describe("Java requirements", () => {
  it.each([
    ["1.12.2", 8],
    ["1.16.5", 8],
    ["1.17.1", 16],
    ["1.18.2", 17],
    ["1.20.4", 17],
    ["1.20.5", 21],
    ["1.21.4", 21],
    ["24w14a", 21],
  ])("falls back to Java %s -> %i", (v, major) => expect(fallbackJavaMajor(v)).toBe(major));

  it("maps requirements to installable LTS JREs", () => {
    expect([8, 16, 17, 21, 22].map(installableMajor)).toEqual([8, 17, 17, 21, 25]);
  });

  it("judges runtime fit", () => {
    expect(javaFit(17, 21)).toBe("too-old");
    expect(javaFit(21, 21)).toBe("ok");
    expect(javaFit(25, 21)).toBe("ok");
    expect(javaFit(21, 8)).toBe("too-new-risky");
    expect(javaFit(8, 8)).toBe("ok");
  });

  it("reads class file versions", () => {
    expect(javaMajorForClassVersion(65)).toBe(21);
    expect(javaMajorForClassVersion(61)).toBe(17);
    expect(javaMajorForClassVersion(52)).toBe(8);
  });
});
