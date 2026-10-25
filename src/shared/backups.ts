/** Backup types shared by the main process and the UI. */

/** manual: made by the user. scheduled: made on the server's timer. safety: made automatically before a restore. */
export type BackupKind = "manual" | "scheduled" | "safety";

export interface BackupInfo {
  /** File name without ".zip"; unique within the server's backup folder. */
  id: string;
  serverId: string;
  serverName: string;
  createdAt: string;
  kind: BackupKind;
  note: string;
  minecraftVersion: string;
  type: string;
  loaderVersion: string | null;
  files: number;
  /** Size of the files before compression. */
  bytes: number;
  /** Size of the archive. */
  sizeOnDisk: number;
  /** Every entry was read back and matched its checksum after writing. */
  verified: boolean;
  /** The server was running; NexCraft paused saving and flushed the world first. */
  savedWhileRunning: boolean;
}

export interface RestorePreview {
  backup: BackupInfo;
  /** Top-level files and folders that will be replaced by the backup's copy. */
  replaces: string[];
  /** Top-level items in the backup that the server folder does not have now. */
  adds: string[];
  /** Items in the server folder the backup does not hold; they are left as they are. */
  keeps: string[];
  warnings: string[];
}
