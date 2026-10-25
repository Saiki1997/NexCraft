/**
 * Values injected at build time by scripts/build-electron.mjs. The CurseForge key
 * comes from the CURSEFORGE_API_KEY environment variable (a GitHub Actions secret
 * in CI) and is never committed to the repository.
 */
declare const __NEXCRAFT_VERSION__: string;
declare const __NEXCRAFT_CURSEFORGE_KEY__: string;

export const APP_VERSION: string = typeof __NEXCRAFT_VERSION__ === "string" ? __NEXCRAFT_VERSION__ : "0.0.0-dev";
export const BUILT_IN_CURSEFORGE_KEY: string = typeof __NEXCRAFT_CURSEFORGE_KEY__ === "string" ? __NEXCRAFT_CURSEFORGE_KEY__ : "";

/** Modrinth asks every client to identify itself with a unique User-Agent. */
export const USER_AGENT = `Saiki1997/NexCraft/${APP_VERSION} (github.com/Saiki1997/NexCraft)`;
