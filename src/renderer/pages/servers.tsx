import { ArrowLeft, FolderOpen, Play, PlusCircle, RotateCw, Server, Square, Trash2, TriangleAlert, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { PropertyField } from "../../shared/ipc";
import type { ServerInstance } from "../../shared/model";
import { memoryWarning, type ServerState, type ServerStatus } from "../../shared/servers";
import { Badge, Button, Card, Dialog, EmptyState, Field, inputClass, PageHeader } from "../components/ui";
import { call } from "../lib/api";
import { cn, formatTime } from "../lib/format";
import { refreshServers, useAppInfo, useConsole, useJavaRuntimes, useServers, useServerStatuses } from "../lib/store";

const EULA_URL = "https://aka.ms/MinecraftEULA";

const STATE_LABEL: Record<ServerState, { label: string; tone: "neutral" | "good" | "warn" | "bad" | "accent" }> = {
  stopped: { label: "Stopped", tone: "neutral" },
  starting: { label: "Starting", tone: "accent" },
  running: { label: "Running", tone: "good" },
  stopping: { label: "Stopping", tone: "warn" },
  crashed: { label: "Crashed", tone: "bad" },
};

const TYPE_LABEL: Record<ServerInstance["type"], string> = { vanilla: "Vanilla", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };

export function serverKind(s: ServerInstance) {
  return s.type === "vanilla" ? `Vanilla ${s.minecraftVersion}` : `${TYPE_LABEL[s.type]} ${s.loaderVersion ?? ""} · Minecraft ${s.minecraftVersion}`;
}

const toastError = (e: unknown) => toast.error((e as Error).message);

export function ServersPage({ selected, onSelect, onCreate }: { selected: string | null; onSelect: (id: string | null) => void; onCreate: () => void }) {
  const servers = useServers();
  const statuses = useServerStatuses();
  const server = servers?.find((s) => s.id === selected);

  if (server) return <ServerDetail server={server} status={statuses[server.id]} onBack={() => onSelect(null)} />;

  return (
    <>
      <PageHeader
        title="Servers"
        description="Start, stop and manage your servers."
        actions={
          <Button variant="primary" onClick={onCreate}>
            <PlusCircle className="size-4" />
            Create server
          </Button>
        }
      />
      {servers && servers.length === 0 && (
        <EmptyState icon={<Server className="size-8" />} title="No servers yet">
          Create a Vanilla or modded server to get started.
        </EmptyState>
      )}
      <div className="grid gap-3 xl:grid-cols-2">
        {servers?.map((s) => (
          <ServerCard key={s.id} server={s} status={statuses[s.id]} onOpen={() => onSelect(s.id)} />
        ))}
      </div>
    </>
  );
}

function ServerCard({ server, status, onOpen }: { server: ServerInstance; status?: ServerStatus; onOpen: () => void }) {
  const state = status?.state ?? "stopped";
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={onOpen} className="min-w-0 text-left">
          <h2 className="truncate font-semibold hover:text-accent-strong">{server.name}</h2>
          <p className="text-xs text-muted">
            {serverKind(server)} · port {server.port} · {(server.memoryMb / 1024).toFixed(1)} GB
          </p>
        </button>
        <Badge tone={STATE_LABEL[state].tone}>{STATE_LABEL[state].label}</Badge>
      </div>
      <Stats status={status} server={server} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Controls server={server} status={status} />
        <Button variant="ghost" onClick={onOpen}>
          Console and settings
        </Button>
      </div>
    </section>
  );
}

function Stats({ server, status }: { server: ServerInstance; status?: ServerStatus }) {
  const running = status && (status.state === "running" || status.state === "starting" || status.state === "stopping");
  return (
    <dl className="mt-3 grid grid-cols-4 gap-2 text-xs">
      <Stat label="Players" value={running ? String(status.players.length) : "–"} />
      <Stat label="CPU" value={running && status.cpuPercent != null ? `${status.cpuPercent.toFixed(0)}%` : "–"} />
      <Stat label="Memory" value={running && status.memoryMb != null ? `${(status.memoryMb / 1024).toFixed(1)} GB` : "–"} />
      <Stat label={running ? "Up since" : "Last started"} value={running && status.startedAt ? new Date(status.startedAt).toLocaleTimeString() : formatTime(server.lastStartedAt)} />
    </dl>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-2 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

/** Start, stop, restart and force stop, with the EULA and force-stop confirmations. */
function Controls({ server, status }: { server: ServerInstance; status?: ServerStatus }) {
  const state = status?.state ?? "stopped";
  const [busy, setBusy] = useState(false);
  const [eula, setEula] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const live = state === "running" || state === "starting" || state === "stopping";

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (!server.eulaAccepted) return setEula(true);
    void run(() => call("servers:start", { id: server.id }));
  };
  const stop = () =>
    void run(async () => {
      const r = await call("servers:stop", { id: server.id });
      if (r === "timeout") toast.warning(`${server.name} has not stopped yet. You can keep waiting or force stop it.`);
    });

  return (
    <>
      {!live && (
        <Button variant="primary" disabled={busy} onClick={start}>
          <Play className="size-4" />
          Start
        </Button>
      )}
      {live && (
        <Button disabled={busy || state === "stopping"} onClick={stop}>
          <Square className="size-4" />
          Stop
        </Button>
      )}
      {state === "running" && (
        <Button disabled={busy} onClick={() => void run(() => call("servers:restart", { id: server.id }))}>
          <RotateCw className="size-4" />
          Restart
        </Button>
      )}
      {live && (
        <Button variant="danger" disabled={busy} onClick={() => setConfirmKill(true)}>
          <Zap className="size-4" />
          Force stop
        </Button>
      )}
      {eula && (
        <EulaDialog
          server={server}
          onClose={() => setEula(false)}
          onAccepted={() => {
            setEula(false);
            refreshServers();
            void run(() => call("servers:start", { id: server.id }));
          }}
        />
      )}
      {confirmKill && (
        <Dialog
          title={`Force stop ${server.name}?`}
          onClose={() => setConfirmKill(false)}
          actions={
            <>
              <Button onClick={() => setConfirmKill(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmKill(false);
                  void run(() => call("servers:force-stop", { id: server.id, confirmed: true }));
                }}
              >
                Force stop
              </Button>
            </>
          }
        >
          <p>This ends the server immediately without saving. Anything that changed in the world since the last autosave can be lost.</p>
          <p className="text-muted">Try Stop first. It asks the server to save and shut down, which can take a minute on a large world.</p>
        </Dialog>
      )}
    </>
  );
}

function EulaDialog({ server, onClose, onAccepted }: { server: ServerInstance; onClose: () => void; onAccepted: () => void }) {
  const [ticked, setTicked] = useState(false);
  const accept = async () => {
    try {
      await call("servers:accept-eula", { id: server.id, accepted: true });
      onAccepted();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog
      title="Minecraft End User License Agreement"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Not now</Button>
          <Button variant="primary" disabled={!ticked} onClick={() => void accept()}>
            Accept and start
          </Button>
        </>
      }
    >
      <p>
        Mojang requires everyone who runs a Minecraft server to agree to the Minecraft EULA. NexCraft cannot accept it for you, and the server will not start
        until you do.
      </p>
      <p>
        Read it at{" "}
        <a href={EULA_URL} target="_blank" rel="noreferrer" className="text-accent-strong underline">
          {EULA_URL}
        </a>
        .
      </p>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
        <span>I have read and agree to the Minecraft EULA for {server.name}.</span>
      </label>
    </Dialog>
  );
}

type Tab = "console" | "properties" | "resources";

function ServerDetail({ server, status, onBack }: { server: ServerInstance; status?: ServerStatus; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("console");
  const state = status?.state ?? "stopped";
  return (
    <>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft className="size-4" /> All servers
      </button>
      <PageHeader
        title={server.name}
        description={`${serverKind(server)} · Java ${server.requiredJava} · ${server.directory}`}
        actions={
          <>
            <Badge tone={STATE_LABEL[state].tone}>{STATE_LABEL[state].label}</Badge>
            <Button variant="ghost" onClick={() => void call("servers:open-folder", { id: server.id }).catch(toastError)}>
              <FolderOpen className="size-4" />
              Open folder
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Controls server={server} status={status} />
      </div>
      <Stats server={server} status={status} />
      {status?.findings.length ? <Findings status={status} /> : null}
      <div role="tablist" className="mt-5 mb-3 flex gap-1 border-b border-border">
        {(
          [
            ["console", "Console"],
            ["properties", "Server properties"],
            ["resources", "Memory and Java"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === id ? "border-accent font-medium" : "border-transparent text-muted hover:text-text")}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "console" && <ConsoleView server={server} running={state === "running" || state === "starting"} />}
      {tab === "properties" && <PropertiesEditor server={server} />}
      {tab === "resources" && <ResourcesEditor server={server} onRemoved={onBack} running={state !== "stopped" && state !== "crashed"} />}
    </>
  );
}

function Findings({ status }: { status: ServerStatus }) {
  return (
    <div className="mt-4 space-y-2">
      {status.findings.map((f) => (
        <div
          key={f.id}
          className={cn("rounded-lg border p-3 text-sm", f.severity === "error" ? "border-bad/40 bg-bad/5" : f.severity === "warning" ? "border-warn/40 bg-warn/5" : "border-border")}
        >
          <div className="flex items-center gap-2 font-medium">
            <TriangleAlert className={cn("size-4", f.severity === "error" ? "text-bad" : "text-warn")} />
            {f.title}
          </div>
          <p className="mt-1 text-muted">{f.explanation}</p>
          <p className="mt-1">{f.fix}</p>
        </div>
      ))}
    </div>
  );
}

function ConsoleView({ server, running }: { server: ServerInstance; running: boolean }) {
  const lines = useConsole(server.id);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const send = async () => {
    const text = command.trim();
    if (!text) return;
    try {
      await call("servers:send-command", { id: server.id, command: text });
      setHistory((h) => [...h.filter((c) => c !== text), text].slice(-100));
      setCommand("");
      setCursor(null);
    } catch (e) {
      toastError(e);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") return void send();
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    if (!history.length) return;
    const next = e.key === "ArrowUp" ? (cursor == null ? history.length - 1 : Math.max(0, cursor - 1)) : cursor == null ? null : cursor + 1;
    if (next == null || next >= history.length) {
      setCursor(null);
      setCommand("");
    } else {
      setCursor(next);
      setCommand(history[next]);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="h-[28rem] overflow-auto px-3 py-2 font-mono text-xs leading-5"
        role="log"
        aria-live="off"
      >
        {lines.length === 0 && <p className="text-muted">Nothing yet. Console output appears here when the server starts.</p>}
        {lines.map((l) => (
          <div
            key={l.seq}
            className={cn(
              "whitespace-pre-wrap break-all",
              l.stream === "stderr" && "text-bad",
              l.stream === "system" && "text-accent-strong",
              l.stream === "input" && "text-muted",
              /\/(WARN|WARNING)\]/.test(l.text) && "text-warn",
              /\/(ERROR|FATAL)\]/.test(l.text) && "text-bad",
            )}
          >
            {l.text}
          </div>
        ))}
      </div>
      <div className="flex gap-2 border-t border-border p-2">
        <input
          className={cn(inputClass, "flex-1 font-mono")}
          placeholder={running ? "Type a command, for example: say Hello, or op YourName" : "Start the server to send commands"}
          value={command}
          disabled={!running}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKey}
          aria-label="Server command"
          maxLength={1000}
        />
        <Button variant="primary" disabled={!running || !command.trim()} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </div>
  );
}

function PropertiesEditor({ server }: { server: ServerInstance }) {
  const [fields, setFields] = useState<PropertyField[]>([]);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call("servers:get-properties", { id: server.id })
      .then((r) => {
        setFields(r.fields);
        setSaved(r.values);
        setDraft(r.values);
      })
      .catch((e: Error) => setError(e.message));
  }, [server.id]);

  const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => saved[k] !== v));
  const groups = [...new Set(fields.map((f) => f.group))];

  const save = async () => {
    try {
      const r = await call("servers:update-properties", { id: server.id, values: changed });
      setSaved(r.values);
      setDraft(r.values);
      refreshServers();
      toast.success(r.restartRequired ? "Saved. Restart the server to apply the changes." : "Saved");
    } catch (e) {
      toastError(e);
    }
  };

  if (error) return <p className="text-sm text-bad">{error}</p>;
  const value = (f: PropertyField) => draft[f.key] ?? f.defaultValue;
  const setValue = (key: string, v: string) => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <div className="grid max-w-3xl gap-4">
      {groups.map((g) => (
        <Card key={g} title={g}>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields
              .filter((f) => f.group === g)
              .map((f) =>
                f.kind.type === "bool" ? (
                  <label key={f.key} className="flex items-start gap-2 text-sm" title={f.help}>
                    <input type="checkbox" className="mt-1" checked={value(f) === "true"} onChange={(e) => setValue(f.key, String(e.target.checked))} />
                    <span>
                      <span className="font-medium">{f.label}</span>
                      <span className="block text-xs text-muted">{f.help}</span>
                    </span>
                  </label>
                ) : (
                  <Field key={f.key} label={f.label} hint={f.help}>
                    {f.kind.type === "enum" ? (
                      <select className={cn(inputClass, "w-full")} value={value(f)} onChange={(e) => setValue(f.key, e.target.value)}>
                        {(f.kind.options.includes(value(f)) ? f.kind.options : [value(f), ...f.kind.options]).map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={cn(inputClass, "w-full")}
                        type={f.kind.type === "int" ? "number" : "text"}
                        min={f.kind.type === "int" ? f.kind.min : undefined}
                        max={f.kind.type === "int" ? f.kind.max : undefined}
                        value={value(f)}
                        onChange={(e) => setValue(f.key, e.target.value)}
                      />
                    )}
                  </Field>
                ),
              )}
          </div>
        </Card>
      ))}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!Object.keys(changed).length} onClick={() => void save()}>
          Save changes
        </Button>
        <Button variant="ghost" disabled={!Object.keys(changed).length} onClick={() => setDraft(saved)}>
          Discard
        </Button>
        <span className="text-xs text-muted">Other keys in server.properties are kept exactly as they are.</span>
      </div>
    </div>
  );
}

function ResourcesEditor({ server, running, onRemoved }: { server: ServerInstance; running: boolean; onRemoved: () => void }) {
  const info = useAppInfo();
  const [java] = useJavaRuntimes();
  const [name, setName] = useState(server.name);
  const [memoryMb, setMemoryMb] = useState(server.memoryMb);
  const [javaId, setJavaId] = useState(server.javaRuntimeId);
  const [args, setArgs] = useState(server.extraJvmArgs.join(" "));
  const [autoRestart, setAutoRestart] = useState(server.autoRestart);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const warning = info ? memoryWarning(memoryMb, info.totalMemoryMb) : null;
  const suitable = java?.filter((r) => r.major >= server.requiredJava) ?? [];

  const save = async () => {
    try {
      const extraJvmArgs = args.split(/\s+/).filter(Boolean);
      const r = await call("servers:update-resources", { id: server.id, patch: { name: name.trim(), memoryMb, javaRuntimeId: javaId, extraJvmArgs, autoRestart } });
      refreshServers();
      toast.success(r.restartRequired ? "Saved. Restart the server to apply the changes." : "Saved");
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async () => {
    try {
      await call("servers:remove", { id: server.id });
      refreshServers();
      toast.success(`${server.name} was removed from NexCraft. Its files are still in ${server.directory}.`);
      onRemoved();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="grid max-w-3xl gap-4">
      <Card title="Server">
        <div className="grid gap-3">
          <Field label="Name">
            <input className={cn(inputClass, "w-full")} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={`Memory: ${(memoryMb / 1024).toFixed(1)} GB`} hint={warning && <span className="text-warn">{warning}</span>}>
            <input
              type="range"
              min={1024}
              max={info ? Math.min(65536, Math.max(2048, Math.floor(info.totalMemoryMb / 512) * 512)) : 16384}
              step={512}
              value={memoryMb}
              onChange={(e) => setMemoryMb(Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
          </Field>
          <Field label="Java" hint={`Minecraft ${server.minecraftVersion} needs Java ${server.requiredJava} or newer. Manage runtimes in Settings.`}>
            <select className={cn(inputClass, "w-full")} value={javaId ?? ""} onChange={(e) => setJavaId(e.target.value || null)}>
              <option value="">Automatic</option>
              {suitable.map((r) => (
                <option key={r.id} value={r.id}>
                  Java {r.version} ({r.vendor || "unknown vendor"}) {r.executable}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Extra JVM options" hint="Separated by spaces, for example -XX:+UseG1GC. Memory is set above; -jar and classpath options are not allowed here.">
            <input className={cn(inputClass, "w-full font-mono")} value={args} onChange={(e) => setArgs(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoRestart} onChange={(e) => setAutoRestart(e.target.checked)} />
            Restart automatically after a crash (paused after 3 crashes in 10 minutes)
          </label>
          <div>
            <Button variant="primary" onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Remove">
        <p className="mb-3 text-sm text-muted">Removing takes the server out of NexCraft. Its folder, world and files stay on disk.</p>
        <Button variant="danger" disabled={running} onClick={() => setConfirmRemove(true)}>
          <Trash2 className="size-4" />
          Remove from NexCraft
        </Button>
        {running && <p className="mt-2 text-xs text-muted">Stop the server first.</p>}
      </Card>
      {confirmRemove && (
        <Dialog
          title={`Remove ${server.name}?`}
          onClose={() => setConfirmRemove(false)}
          actions={
            <>
              <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => void remove()}>
                Remove
              </Button>
            </>
          }
        >
          <p>NexCraft will forget this server. Nothing is deleted: the files stay in {server.directory}.</p>
        </Dialog>
      )}
    </div>
  );
}
