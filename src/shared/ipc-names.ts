/**
 * Channel and event names only, with no dependencies, so the preload script can
 * check them without bundling zod. A test keeps this list in sync with ipc.ts.
 */
export const CHANNEL_NAMES = [
  "app:info",
  "settings:get",
  "settings:update",
  "settings:set-curseforge-key",
  "servers:list",
  "jobs:list",
  "jobs:cancel",
  "jobs:clear-finished",
  "logs:recent",
  "shell:open-folder",
  "dialog:pick-folder",
] as const;

export const EVENT_NAMES = ["jobs:changed", "log:entry"] as const;
