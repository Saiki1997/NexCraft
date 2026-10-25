/**
 * Decide where NexCraft keeps its data.
 *
 * The portable ZIP ships a `portable.txt` marker next to NexCraft.exe. When it is
 * present and the folder is writable, everything lives in `<exe folder>/data`, so
 * the whole app can be moved or deleted as one folder. Otherwise data goes to the
 * per-user app data folder.
 */
import fs from "node:fs";
import path from "node:path";

export interface DataDirInput {
  exeDir: string;
  userDataDir: string;
  isPackaged: boolean;
  /** Dev builds use this folder instead (the repo's ./data). */
  devDir: string;
}

export interface DataDirResult {
  dataDir: string;
  portable: boolean;
  /** Why portable mode was skipped even though the marker exists. */
  warning: string | null;
}

export const PORTABLE_MARKER = "portable.txt";

export function resolveDataDir(input: DataDirInput, fsImpl: Pick<typeof fs, "existsSync" | "mkdirSync" | "accessSync"> = fs): DataDirResult {
  if (!input.isPackaged) {
    fsImpl.mkdirSync(input.devDir, { recursive: true });
    return { dataDir: input.devDir, portable: false, warning: null };
  }
  if (fsImpl.existsSync(path.join(input.exeDir, PORTABLE_MARKER))) {
    const dir = path.join(input.exeDir, "data");
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      fsImpl.accessSync(dir, fs.constants.W_OK);
      return { dataDir: dir, portable: true, warning: null };
    } catch (err) {
      fsImpl.mkdirSync(input.userDataDir, { recursive: true });
      return {
        dataDir: input.userDataDir,
        portable: false,
        warning: `NexCraft's folder is not writable (${(err as Error).message}). Data is stored in ${input.userDataDir} instead.`,
      };
    }
  }
  fsImpl.mkdirSync(input.userDataDir, { recursive: true });
  return { dataDir: input.userDataDir, portable: false, warning: null };
}
