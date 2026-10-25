import { useState } from "react";
import { toast } from "sonner";
import { call } from "../lib/api";
import { useAppInfo, useJavaRuntimes, useSettings } from "../lib/store";
import { Badge, Button, Card, PageHeader } from "../components/ui";
import type { SettingsPatch, SettingsView } from "../../shared/ipc";

export function SettingsPage({ onTheme }: { onTheme: (t: SettingsView["theme"]) => void }) {
  const [settings, setSettings] = useSettings();
  const info = useAppInfo();
  const [key, setKey] = useState("");

  if (!settings) return <PageHeader title="Settings" description="Loading…" />;

  const patch = async (p: SettingsPatch) => {
    try {
      const next = await call("settings:update", p);
      setSettings(next);
      if (p.theme) onTheme(p.theme);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const pick = async (purpose: "servers" | "java" | "backups") => {
    const dir = await call("dialog:pick-folder", { purpose }).catch((e: Error) => (toast.error(e.message), null));
    if (dir) await patch({ [`${purpose}Dir`]: dir } as SettingsPatch);
  };

  const saveKey = async (value: string | null) => {
    try {
      setSettings(await call("settings:set-curseforge-key", { key: value }));
      setKey("");
      toast.success(value ? "CurseForge key saved (encrypted with Windows secure storage)" : "Your CurseForge key was removed");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="Preferences are saved as soon as you change them." />
      <div className="grid max-w-3xl gap-4">
        <Card title="Appearance">
          <Field label="Theme">
            <select
              value={settings.theme}
              onChange={(e) => void patch({ theme: e.target.value as SettingsView["theme"] })}
              className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Match Windows</option>
            </select>
          </Field>
        </Card>

        <Card title="Storage">
          <Folder label="New servers" value={settings.serversDir} fallback="servers" onPick={() => void pick("servers")} onReset={() => void patch({ serversDir: "" })} />
          <Folder label="Java runtimes" value={settings.javaDir} fallback="java" onPick={() => void pick("java")} onReset={() => void patch({ javaDir: "" })} />
          <Folder label="Backups" value={settings.backupsDir} fallback="backups" onPick={() => void pick("backups")} onReset={() => void patch({ backupsDir: "" })} />
          {info && <p className="mt-2 text-xs text-muted">Default location: {info.dataDir}</p>}
        </Card>

        <JavaCard isWindows={info?.platform === "win32"} />

        <Card title="Downloads and shutdown">
          <Field label="Parallel downloads">
            <input
              type="number"
              min={1}
              max={8}
              value={settings.maxParallelDownloads}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 1 && n <= 8) void patch({ maxParallelDownloads: n });
              }}
              className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="When quitting with servers running">
            <select
              value={settings.onQuit}
              onChange={(e) => void patch({ onQuit: e.target.value as SettingsView["onQuit"] })}
              className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm"
            >
              <option value="ask">Ask me first</option>
              <option value="stop-servers">Stop them safely without asking</option>
            </select>
          </Field>
        </Card>

        <Card title="CurseForge">
          <p className="mb-3 text-sm text-muted">
            NexCraft uses CurseForge's official API to find mods and modpacks.{" "}
            {info?.curseforgeKey === "built-in"
              ? "A key is built in. You can use your own instead."
              : "This build has no key, so CurseForge features stay off until you add one. Modrinth works without a key."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={settings.hasCurseforgeKeyOverride ? "Your key is saved" : "Paste your CurseForge API key"}
              aria-label="CurseForge API key"
              className="w-80 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm"
            />
            <Button variant="primary" disabled={!key.trim()} onClick={() => void saveKey(key.trim())}>
              Save key
            </Button>
            {settings.hasCurseforgeKeyOverride && (
              <Button variant="danger" onClick={() => void saveKey(null)}>
                Remove my key
              </Button>
            )}
          </div>
        </Card>

        <Card title="About">
          {info && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">NexCraft {info.version}</span>
              <Badge>{info.portable ? "Portable" : "Installed"}</Badge>
              <Badge>
                {info.platform} {info.arch}
              </Badge>
            </div>
          )}
          <p className="mt-2 text-xs text-muted">
            Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft. Released under the MIT License.
          </p>
        </Card>
      </div>
    </>
  );
}

function JavaCard({ isWindows }: { isWindows: boolean }) {
  const [runtimes] = useJavaRuntimes();
  const [busy, setBusy] = useState<string | null>(null);
  const [major, setMajor] = useState(21);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Java"
      actions={
        <div className="flex gap-2">
          <Button variant="ghost" disabled={!!busy} onClick={() => void run("scan", () => call("java:detect", {}))}>
            {busy === "scan" ? "Scanning…" : "Scan again"}
          </Button>
          <Button disabled={!!busy} onClick={() => void run("add", () => call("java:add-custom", {}))}>
            Add java.exe…
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Each server uses the Java version its Minecraft release needs. NexCraft finds Java in the usual places, including the one bundled with the Minecraft
        Launcher, and can install Eclipse Temurin for you.
      </p>
      {runtimes && runtimes.length === 0 && <p className="mb-3 text-sm">No Java found yet. NexCraft installs one when you create a server, or you can install one below.</p>}
      <ul className="divide-y divide-border text-sm">
        {runtimes?.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">Java {r.version}</span>
                <Badge tone={r.source === "managed" ? "accent" : "neutral"}>{r.source === "managed" ? "Installed by NexCraft" : r.source === "custom" ? "Added by you" : "Found"}</Badge>
                {r.arch !== "x64" && r.arch !== "unknown" && <Badge tone="warn">{r.arch}</Badge>}
              </div>
              <div className="truncate text-xs text-muted" title={r.executable}>
                {r.vendor || "Unknown vendor"} · {r.executable}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button variant="ghost" disabled={!!busy} onClick={() => void run(r.id, () => call("java:verify", { id: r.id }), `Java ${r.major} works`)}>
                Check
              </Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => void run(r.id, () => call("java:forget", { id: r.id }))}>
                Forget
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-sm">
        <span>Install Temurin</span>
        <select value={major} onChange={(e) => setMajor(Number(e.target.value))} className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm" disabled={!isWindows}>
          {[25, 21, 17, 11, 8].map((m) => (
            <option key={m} value={m}>
              Java {m}
            </option>
          ))}
        </select>
        <Button disabled={!!busy || !isWindows} onClick={() => void run("install", () => call("java:install", { major }), `Java ${major} installed`)}>
          {busy === "install" ? "Installing…" : "Install"}
        </Button>
        {!isWindows && <span className="text-xs text-muted">Automatic install is available on Windows.</span>}
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Folder({ label, value, fallback, onPick, onReset }: { label: string; value: string; fallback: string; onPick: () => void; onReset: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <div className="min-w-0">
        <div>{label}</div>
        <div className="truncate text-xs text-muted" title={value || undefined}>
          {value || `Default (data\\${fallback})`}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {value && (
          <Button variant="ghost" onClick={onReset}>
            Use default
          </Button>
        )}
        <Button onClick={onPick}>Choose…</Button>
      </div>
    </div>
  );
}
