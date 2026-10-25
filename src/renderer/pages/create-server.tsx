import { Check, CircleAlert, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { MinecraftVersionList } from "../../shared/ipc";
import { memoryWarning, type InstallProgress } from "../../shared/servers";
import { Badge, Button, Card, Field, inputClass, PageHeader } from "../components/ui";
import { call, subscribe } from "../lib/api";
import { cn } from "../lib/format";
import { refreshServers, useAppInfo, useJavaRuntimes } from "../lib/store";

const STEPS: { id: InstallProgress["step"]; label: string }[] = [
  { id: "version", label: "Look up the version" },
  { id: "java", label: "Find or install Java" },
  { id: "download", label: "Download the official server" },
  { id: "loader", label: "Install the mod loader" },
  { id: "files", label: "Write server settings" },
];

type ServerType = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

const TYPES: { id: ServerType; label: string; hint: string }[] = [
  { id: "vanilla", label: "Vanilla (official)", hint: "The official server from Mojang, without mods." },
  { id: "fabric", label: "Fabric", hint: "Lightweight loader, quick to support new Minecraft versions." },
  { id: "quilt", label: "Quilt", hint: "A Fabric-compatible loader. Most Fabric mods work on it." },
  { id: "forge", label: "Forge", hint: "The long-standing loader behind most large modpacks." },
  { id: "neoforge", label: "NeoForge", hint: "The successor to Forge for Minecraft 1.20.2 and newer." },
];

interface Form {
  type: ServerType;
  loaderVersion: string | null;
  name: string;
  minecraftVersion: string;
  worldName: string;
  seed: string;
  port: number;
  maxPlayers: number;
  onlineMode: boolean;
  difficulty: "peaceful" | "easy" | "normal" | "hard";
  gamemode: "survival" | "creative" | "adventure" | "spectator";
  viewDistance: number;
  simulationDistance: number;
  memoryMb: number;
  motd: string;
  javaRuntimeId: string | null;
  autoRestart: boolean;
}

const INITIAL: Form = {
  type: "vanilla",
  loaderVersion: null,
  name: "My Server",
  minecraftVersion: "",
  worldName: "world",
  seed: "",
  port: 25565,
  maxPlayers: 20,
  onlineMode: true,
  difficulty: "easy",
  gamemode: "survival",
  viewDistance: 10,
  simulationDistance: 10,
  memoryMb: 4096,
  motd: "",
  javaRuntimeId: null,
  autoRestart: false,
};

export function CreateServerPage({ onCreated }: { onCreated: (id: string) => void }) {
  const info = useAppInfo();
  const [java] = useJavaRuntimes();
  const [form, setForm] = useState<Form>(INITIAL);
  const [snapshots, setSnapshots] = useState(false);
  const [versions, setVersions] = useState<MinecraftVersionList | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<InstallProgress[] | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    setVersionError(null);
    call("minecraft:versions", { includeSnapshots: snapshots })
      .then((list) => {
        setVersions(list);
        setForm((f) => (f.minecraftVersion && list.versions.some((v) => v.id === f.minecraftVersion) ? f : { ...f, minecraftVersion: list.latest }));
      })
      .catch((e: Error) => setVersionError(e.message));
  }, [snapshots, attempt]);

  const [loaderVersions, setLoaderVersions] = useState<{ versions: { version: string; stable: boolean }[]; recommended: string | null } | null>(null);
  const [loaderError, setLoaderError] = useState<string | null>(null);
  useEffect(() => {
    setLoaderVersions(null);
    setLoaderError(null);
    if (form.type === "vanilla" || !form.minecraftVersion) return;
    let live = true;
    call("loaders:versions", { type: form.type, minecraftVersion: form.minecraftVersion })
      .then((r) => live && setLoaderVersions(r))
      .catch((e: Error) => live && setLoaderError(`Could not load versions: ${e.message}`));
    return () => {
      live = false;
    };
  }, [form.type, form.minecraftVersion]);
  const loaderMissing = form.type !== "vanilla" && (!loaderVersions || loaderVersions.versions.length === 0);

  const warning = info ? memoryWarning(form.memoryMb, info.totalMemoryMb) : null;
  const maxMemory = info ? Math.max(2048, Math.floor(info.totalMemoryMb / 512) * 512) : 16384;
  const reached = useMemo(() => new Set(progress?.map((p) => p.step)), [progress]);
  const failed = progress?.find((p) => p.step === "failed");

  const submit = async () => {
    const progressKey = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    setBusy(true);
    setProgress([]);
    const off = subscribe("server:install", (p) => {
      if (p.key === progressKey) setProgress((prev) => [...(prev ?? []), p]);
    });
    try {
      const server = await call("servers:create", { input: form, progressKey });
      refreshServers();
      toast.success(`${server.name} is ready. Accept the EULA to start it.`);
      onCreated(server.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      off();
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Create server"
        description="NexCraft downloads the official server and mod loader, checks them, and sets up the right Java."
      />
      <div className="grid max-w-4xl gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="grid gap-4">
          <Card title="Basics">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Server name">
                <input className={cn(inputClass, "w-full")} value={form.name} maxLength={64} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Server type" hint={TYPES.find((t) => t.id === form.type)?.hint}>
                <select
                  className={cn(inputClass, "w-full")}
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as ServerType, loaderVersion: null }))}
                >
                  {TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Minecraft version"
                hint={
                  versionError ? (
                    <span className="text-bad">
                      Could not reach Mojang ({versionError}).{" "}
                      <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>
                        Try again
                      </button>
                    </span>
                  ) : versions?.fromCache ? (
                    "Mojang could not be reached, so this list is from the last time NexCraft checked."
                  ) : undefined
                }
              >
                <select className={cn(inputClass, "w-full")} value={form.minecraftVersion} onChange={(e) => set("minecraftVersion", e.target.value)} disabled={!versions}>
                  {!versions && <option>{versionError ? "Unavailable" : "Loading…"}</option>}
                  {versions?.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.id}
                      {v.id === versions.latest ? " (latest)" : v.type === "snapshot" ? " (snapshot)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} />
                Show snapshots
              </label>
              {form.type !== "vanilla" && (
                <Field
                  label={`${TYPES.find((t) => t.id === form.type)?.label} version`}
                  hint={
                    loaderError ? (
                      <span className="text-bad">{loaderError}</span>
                    ) : loaderVersions && loaderVersions.versions.length === 0 ? (
                      <span className="text-warn">This loader does not support Minecraft {form.minecraftVersion} yet. Pick an older Minecraft version.</span>
                    ) : undefined
                  }
                >
                  <select
                    className={cn(inputClass, "w-full")}
                    value={form.loaderVersion ?? ""}
                    onChange={(e) => set("loaderVersion", e.target.value || null)}
                    disabled={!loaderVersions?.versions.length}
                  >
                    <option value="">{loaderVersions ? (loaderVersions.recommended ? `Recommended (${loaderVersions.recommended})` : "None available") : "Loading…"}</option>
                    {loaderVersions?.versions.slice(0, 200).map((v) => (
                      <option key={v.version} value={v.version}>
                        {v.version}
                        {v.stable ? "" : " (beta)"}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Message of the day" hint="Shown in the server list. Leave empty to use the server name.">
                <input className={cn(inputClass, "w-full")} value={form.motd} maxLength={150} onChange={(e) => set("motd", e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card title="World">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="World folder name">
                <input className={cn(inputClass, "w-full")} value={form.worldName} maxLength={64} onChange={(e) => set("worldName", e.target.value)} />
              </Field>
              <Field label="Seed" hint="Leave empty for a random world.">
                <input className={cn(inputClass, "w-full")} value={form.seed} maxLength={64} onChange={(e) => set("seed", e.target.value)} />
              </Field>
              <Field label="Game mode">
                <select className={cn(inputClass, "w-full")} value={form.gamemode} onChange={(e) => set("gamemode", e.target.value as Form["gamemode"])}>
                  <option value="survival">Survival</option>
                  <option value="creative">Creative</option>
                  <option value="adventure">Adventure</option>
                  <option value="spectator">Spectator</option>
                </select>
              </Field>
              <Field label="Difficulty">
                <select className={cn(inputClass, "w-full")} value={form.difficulty} onChange={(e) => set("difficulty", e.target.value as Form["difficulty"])}>
                  <option value="peaceful">Peaceful</option>
                  <option value="easy">Easy</option>
                  <option value="normal">Normal</option>
                  <option value="hard">Hard</option>
                </select>
              </Field>
            </div>
          </Card>

          <Card title="Players and network">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Port">
                <input type="number" min={1024} max={65535} className={cn(inputClass, "w-full")} value={form.port} onChange={(e) => set("port", Number(e.target.value))} />
              </Field>
              <Field label="Max players">
                <input type="number" min={1} max={1000} className={cn(inputClass, "w-full")} value={form.maxPlayers} onChange={(e) => set("maxPlayers", Number(e.target.value))} />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={form.onlineMode} onChange={(e) => set("onlineMode", e.target.checked)} />
                Online mode
              </label>
            </div>
            {!form.onlineMode && (
              <p className="mt-2 text-xs text-warn">With online mode off, anyone can join using any player name, including yours. Only turn it off on a private network.</p>
            )}
          </Card>

          <Card title="Performance">
            <Field label={`Memory: ${(form.memoryMb / 1024).toFixed(1)} GB`} hint={warning ? <span className="text-warn">{warning}</span> : "4 GB suits a small Vanilla server."}>
              <input
                type="range"
                min={1024}
                max={Math.min(maxMemory, 65536)}
                step={512}
                value={form.memoryMb}
                onChange={(e) => set("memoryMb", Number(e.target.value))}
                className="w-full accent-[var(--accent)]"
              />
            </Field>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="View distance (chunks)">
                <input type="number" min={3} max={32} className={cn(inputClass, "w-full")} value={form.viewDistance} onChange={(e) => set("viewDistance", Number(e.target.value))} />
              </Field>
              <Field label="Simulation distance (chunks)">
                <input
                  type="number"
                  min={3}
                  max={32}
                  className={cn(inputClass, "w-full")}
                  value={form.simulationDistance}
                  onChange={(e) => set("simulationDistance", Number(e.target.value))}
                />
              </Field>
              <Field label="Java" hint="Automatic picks the version Mojang lists for this Minecraft release and installs it if needed.">
                <select className={cn(inputClass, "w-full")} value={form.javaRuntimeId ?? ""} onChange={(e) => set("javaRuntimeId", e.target.value || null)}>
                  <option value="">Automatic</option>
                  {java?.map((r) => (
                    <option key={r.id} value={r.id}>
                      Java {r.major} ({r.vendor || "unknown vendor"}, {r.source})
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={form.autoRestart} onChange={(e) => set("autoRestart", e.target.checked)} />
                Restart automatically after a crash
              </label>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Create">
            <Button variant="primary" className="w-full justify-center" disabled={busy || !form.minecraftVersion || !form.name.trim() || loaderMissing} onClick={() => void submit()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Creating…" : "Create server"}
            </Button>
            <p className="mt-3 text-xs text-muted">The server will not start until you read and accept the Minecraft EULA.</p>
            {progress && (
              <ol className="mt-4 space-y-2 text-sm">
                {STEPS.filter(
                  (step) => !(step.id === "loader" && form.type === "vanilla") && !(step.id === "download" && (form.type === "forge" || form.type === "neoforge")),
                ).map((step) => {
                  const done = reached.has(step.id) && (progress.at(-1)?.step !== step.id || reached.has("done"));
                  const active = progress.at(-1)?.step === step.id && !failed;
                  const message = [...progress].reverse().find((p) => p.step === step.id)?.message;
                  return (
                    <li key={step.id} className="flex gap-2">
                      <span className="mt-0.5">
                        {done ? (
                          <Check className="size-4 text-good" />
                        ) : active ? (
                          <Loader2 className="size-4 animate-spin text-accent" />
                        ) : (
                          <span className="block size-4 rounded-full border border-border" />
                        )}
                      </span>
                      <span>
                        {step.label}
                        {message && <span className="block text-xs text-muted">{message}</span>}
                      </span>
                    </li>
                  );
                })}
                {failed && (
                  <li className="flex gap-2 text-bad">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>{failed.message}</span>
                  </li>
                )}
                {reached.has("done") && (
                  <li>
                    <Badge tone="good">Ready</Badge>
                  </li>
                )}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
