import { Archive, FolderOpen, History, Loader2, RotateCcw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { BackupInfo, BackupKind, RestorePreview } from "../../shared/backups";
import type { ServerInstance } from "../../shared/model";
import { Badge, Button, Card, Dialog, EmptyState, Field, inputClass, PageHeader } from "../components/ui";
import { call, subscribe } from "../lib/api";
import { cn, formatBytes, formatTime } from "../lib/format";
import { refreshServers, useServers, useServerStatuses } from "../lib/store";

const KIND: Record<BackupKind, { text: string; tone: "neutral" | "accent" | "warn" }> = {
  manual: { text: "Manual", tone: "neutral" },
  scheduled: { text: "Automatic", tone: "accent" },
  safety: { text: "Before restore", tone: "warn" },
};
const EVERY = [null, 1, 3, 6, 12, 24, 48, 168];

export function BackupsPage() {
  const servers = useServers();
  const [serverId, setServerId] = useState<string | null>(null);
  const server = servers?.find((s) => s.id === serverId) ?? servers?.[0] ?? null;
  return (
    <>
      <PageHeader
        title="Backups"
        description="Save a server's worlds, mods, configs and settings, and restore them safely."
        actions={
          servers && servers.length > 1 && server ? (
            <select className={inputClass} value={server.id} onChange={(e) => setServerId(e.target.value)} aria-label="Server">
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null
        }
      />
      {servers === null ? null : !server ? (
        <EmptyState icon={<Archive className="size-8" />} title="No servers yet">
          Create a server first; its backups will appear here.
        </EmptyState>
      ) : (
        <ServerBackups key={server.id} server={server} />
      )}
    </>
  );
}

function ServerBackups({ server }: { server: ServerInstance }) {
  const statuses = useServerStatuses();
  const state = statuses[server.id]?.state ?? "stopped";
  const running = state !== "stopped" && state !== "crashed";
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = useState<BackupInfo | null>(null);

  const refresh = useCallback(() => {
    call("backups:list", { id: server.id })
      .then(setList)
      .catch((e: Error) => toast.error(e.message));
  }, [server.id]);
  useEffect(() => {
    refresh();
    return subscribe("backups:changed", (p) => p.serverId === server.id && refresh());
  }, [server.id, refresh]);

  const create = async () => {
    setCreating(true);
    try {
      const b = await call("backups:create", { id: server.id, note: note.trim() });
      toast.success(`Backed up ${b.files} files (${formatBytes(b.sizeOnDisk)}), checked and complete`);
      setNote("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
      refresh();
      refreshServers();
    }
  };

  const verified = list?.filter((b) => b.verified) ?? [];

  return (
    <div className="max-w-5xl space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Back up now">
          <div className="space-y-3">
            <Field label="Note" hint="Optional, e.g. “before updating mods”.">
              <input className={cn(inputClass, "w-full")} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Button variant="primary" onClick={() => void create()} disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
              {creating ? "Backing up…" : "Back up now"}
            </Button>
            <p className="text-xs text-muted">
              {running
                ? `${server.name} is running. NexCraft pauses saving and asks it to write the world to disk first, then turns saving back on.`
                : "Worlds, mods, configs and settings are saved. Server software and logs are left out; they stay in place when you restore."}
            </p>
          </div>
        </Card>
        <ScheduleCard server={server} />
      </div>

      {list === null ? (
        <Loader2 className="size-5 animate-spin text-muted" />
      ) : list.length === 0 ? (
        <EmptyState icon={<History className="size-8" />} title="No backups yet">
          Back up now, or switch on automatic backups.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatTime(b.createdAt)}</span>
                  <Badge tone={KIND[b.kind].tone}>{KIND[b.kind].text}</Badge>
                  {b.verified && (
                    <span title="Every file was read back and matched its checksum">
                      <Badge tone="good">
                        <ShieldCheck className="mr-1 inline size-3" />
                        Checked
                      </Badge>
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted">
                  {b.files} files · {formatBytes(b.sizeOnDisk)} · Minecraft {b.minecraftVersion}
                  {b.savedWhileRunning ? " · taken while running" : ""}
                  {b.note ? ` · ${b.note}` : ""}
                </div>
              </div>
              <div className="flex gap-1">
                <Button onClick={() => setRestoring(b)} disabled={running} title={running ? `Stop ${server.name} to restore` : undefined}>
                  <RotateCcw className="size-4" />
                  Restore
                </Button>
                <Button variant="ghost" onClick={() => void call("backups:show", { id: server.id, backupId: b.id }).catch((e: Error) => toast.error(e.message))} aria-label="Show in folder" title="Show in folder">
                  <FolderOpen className="size-4" />
                </Button>
                <Button variant="ghost" onClick={() => setDeleting(b)} aria-label="Delete backup" title="Delete">
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {restoring && <RestoreDialog server={server} backup={restoring} onClose={() => setRestoring(null)} onDone={refresh} />}
      {deleting && (
        <Dialog
          title="Delete this backup?"
          onClose={() => setDeleting(null)}
          actions={
            <>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const b = deleting;
                  setDeleting(null);
                  call("backups:delete", { id: server.id, backupId: b.id })
                    .then(() => toast.success("Backup deleted"))
                    .catch((e: Error) => toast.error(e.message))
                    .finally(refresh);
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p>The backup from {formatTime(deleting.createdAt)} is deleted for good.</p>
          {deleting.verified && verified.length === 1 && (
            <p className="flex gap-2 text-warn">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              This is the only checked backup of {server.name}.
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}

function ScheduleCard({ server }: { server: ServerInstance }) {
  const [everyHours, setEveryHours] = useState(server.backupSchedule.everyHours);
  const [keep, setKeep] = useState(server.backupSchedule.keep);
  const save = async (next: { everyHours: number | null; keep: number }) => {
    setEveryHours(next.everyHours);
    setKeep(next.keep);
    try {
      await call("backups:set-schedule", { id: server.id, ...next });
      refreshServers();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Card title="Automatic backups">
      <div className="space-y-3">
        <Field label="Back up">
          <select className={cn(inputClass, "w-full")} value={everyHours ?? ""} onChange={(e) => void save({ everyHours: e.target.value ? Number(e.target.value) : null, keep })}>
            {EVERY.map((h) => (
              <option key={h ?? "off"} value={h ?? ""}>
                {h === null ? "Off" : h === 1 ? "Every hour" : h === 168 ? "Every week" : `Every ${h} hours`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Keep" hint="The oldest automatic backups are removed beyond this. Manual backups are never removed, and neither is the newest checked backup.">
          <input
            type="number"
            min={1}
            max={100}
            className={cn(inputClass, "w-24")}
            value={keep}
            onChange={(e) => setKeep(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            onBlur={() => keep !== server.backupSchedule.keep && void save({ everyHours, keep })}
          />
        </Field>
        <p className="text-xs text-muted">Last backup: {server.lastBackupAt ? formatTime(server.lastBackupAt) : "never"}. Automatic backups run while NexCraft is open.</p>
      </div>
    </Card>
  );
}

function RestoreDialog({ server, backup, onClose, onDone }: { server: ServerInstance; backup: BackupInfo; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call("backups:preview", { id: server.id, backupId: backup.id })
      .then(setPreview)
      .catch((e: Error) => {
        toast.error(e.message);
        onClose();
      });
  }, [server.id, backup.id, onClose]);

  const restore = async () => {
    setBusy(true);
    try {
      await call("backups:restore", { id: server.id, backupId: backup.id });
      toast.success(`Restored ${server.name} to ${formatTime(backup.createdAt)}. The previous state was saved as a backup first.`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    } finally {
      onDone();
    }
  };

  return (
    <Dialog
      title={`Restore the backup from ${formatTime(backup.createdAt)}?`}
      onClose={() => !busy && onClose()}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void restore()} disabled={busy || !preview}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? "Restoring…" : "Restore"}
          </Button>
        </>
      }
    >
      {!preview ? (
        <Loader2 className="size-5 animate-spin text-muted" />
      ) : (
        <>
          <p>NexCraft first backs up the server as it is now, so this can be undone by restoring that backup.</p>
          {preview.replaces.length > 0 && <Items label="Replaced with the backup's copy" items={preview.replaces} />}
          {preview.adds.length > 0 && <Items label="Brought back" items={preview.adds} />}
          {preview.keeps.length > 0 && <Items label="Left as they are" items={preview.keeps} />}
          {preview.warnings.map((w) => (
            <p key={w} className="flex gap-2 text-warn">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {w}
            </p>
          ))}
        </>
      )}
    </Dialog>
  );
}

function Items({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="font-medium">{label}</p>
      <p className="text-xs break-words text-muted">{items.join(", ")}</p>
    </div>
  );
}
