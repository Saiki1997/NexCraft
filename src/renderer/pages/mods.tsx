import { ArrowUpCircle, FileUp, History, Loader2, Package, Power, PowerOff, Puzzle, RefreshCw, Search, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { ServerInstance } from "../../shared/model";
import type { PackSearchHit } from "../../shared/modpacks";
import type { CompatLabel, InstalledMod, ModChangePlan, ModHistoryEntry, ModList, ModProvider, ModUpdate } from "../../shared/mods";
import { Badge, Button, Card, Dialog, EmptyState, Field, inputClass, PageHeader } from "../components/ui";
import { call } from "../lib/api";
import { cn, formatBytes, formatTime } from "../lib/format";
import { useServers, useServerStatuses } from "../lib/store";
import { ManualDownloads } from "./modpacks";

type Tab = "installed" | "add" | "history";
type Version = { id: string; name: string; gameVersions: string[]; loaders: string[]; date: string; stable: boolean };

const LABELS: Record<CompatLabel, { text: string; tone: "good" | "accent" | "warn" | "neutral" | "bad" }> = {
  confirmed: { text: "Confirmed", tone: "good" },
  metadata: { text: "From metadata", tone: "accent" },
  conflict: { text: "Suspected conflict", tone: "warn" },
  unknown: { text: "Unknown", tone: "neutral" },
  incompatible: { text: "Incompatible", tone: "bad" },
};
const LOADER_LABEL: Record<string, string> = { fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };

export function ModsPage() {
  const servers = useServers();
  const modded = useMemo(() => servers?.filter((s) => s.type !== "vanilla") ?? [], [servers]);
  const [serverId, setServerId] = useState<string | null>(null);
  const server = modded.find((s) => s.id === serverId) ?? modded[0] ?? null;

  return (
    <>
      <PageHeader
        title="Mods"
        description="Add, update, switch off and remove mods. Every change is shown before it happens and can be undone."
        actions={
          modded.length > 1 && server ? (
            <select className={inputClass} value={server.id} onChange={(e) => setServerId(e.target.value)} aria-label="Server">
              {modded.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null
        }
      />
      {servers === null ? null : !server ? (
        <EmptyState icon={<Puzzle className="size-8" />} title="No modded servers yet">
          Mods need a Fabric, Quilt, Forge or NeoForge server. Create one, or import a modpack.
        </EmptyState>
      ) : (
        <ServerMods key={server.id} server={server} />
      )}
    </>
  );
}

function ServerMods({ server }: { server: ServerInstance }) {
  const statuses = useServerStatuses();
  const state = statuses[server.id]?.state ?? "stopped";
  const locked = state !== "stopped" && state !== "crashed";
  const [tab, setTab] = useState<Tab>("installed");
  const [list, setList] = useState<ModList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ModChangePlan | null>(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => {
    setError(null);
    call("mods:list", { id: server.id })
      .then(setList)
      .catch((e: Error) => setError(e.message));
    setVersion((v) => v + 1);
  }, [server.id]);
  useEffect(refresh, [refresh]);

  const run = async (fn: () => Promise<{ summary: string }>) => {
    try {
      toast.success((await fn()).summary);
    } catch (e) {
      toast.error((e as Error).message);
    }
    refresh();
  };

  return (
    <div className="max-w-5xl space-y-4">
      <p className="text-sm text-muted">
        {server.name} · {LOADER_LABEL[server.type] ?? server.type} {server.loaderVersion ?? ""} · Minecraft {server.minecraftVersion}
      </p>
      {locked && (
        <p className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <TriangleAlert className="size-4 text-warn" /> Stop {server.name} to change its mods. Changes apply the next time it starts.
        </p>
      )}
      <ManualDownloads key={version} serverId={server.id} />
      <div role="tablist" className="flex gap-1 border-b border-border">
        {(
          [
            ["installed", `Installed${list ? ` (${list.mods.length})` : ""}`],
            ["add", "Add mods"],
            ["history", "History"],
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
      {error && <p className="text-sm text-bad">{error}</p>}
      {tab === "installed" && <Installed server={server} list={list} locked={locked} run={run} onPlan={setPlan} onRefresh={refresh} />}
      {tab === "add" && <AddMods server={server} locked={locked} onPlan={setPlan} />}
      {tab === "history" && <HistoryView server={server} locked={locked} version={version} run={run} />}
      {plan && (
        <PlanDialog
          plan={plan}
          locked={locked}
          onClose={() => setPlan(null)}
          onApplied={(summary) => {
            setPlan(null);
            toast.success(summary);
            refresh();
            setTab("installed");
          }}
        />
      )}
    </div>
  );
}

function Installed({
  server,
  list,
  locked,
  run,
  onPlan,
  onRefresh,
}: {
  server: ServerInstance;
  list: ModList | null;
  locked: boolean;
  run: (fn: () => Promise<{ summary: string }>) => Promise<void>;
  onPlan: (p: ModChangePlan) => void;
  onRefresh: () => void;
}) {
  const [updates, setUpdates] = useState<ModUpdate[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState<InstalledMod | null>(null);

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const u = await call("mods:check-updates", { id: server.id });
      setUpdates(u);
      if (!u.length) toast.success("Every mod NexCraft can check is up to date");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const planUpdate = async (u: ModUpdate[]) => {
    try {
      onPlan(await call("mods:plan-update", { id: server.id, updates: u.map(({ file, provider, projectId, versionId }) => ({ file, provider, projectId, versionId })) }));
      setUpdates(null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const addFiles = async () => {
    try {
      const r = await call("mods:add-files", { id: server.id });
      if (!r) return;
      if (r.added.length) toast.success(`Added ${r.added.join(", ")}`);
      if (r.rejected.length) toast.error(`${r.rejected.join(", ")} ${r.rejected.length === 1 ? "is" : "are"} not a mod jar`);
      onRefresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!list) return <Loader2 className="size-5 animate-spin text-muted" />;
  const counts = list.mods.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.label]: (acc[m.label] ?? 0) + 1 }), {});
  const updateFor = (file: string) => updates?.find((u) => u.file === file);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void checkUpdates()} disabled={checking}>
          {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Check for updates
        </Button>
        <Button onClick={() => void addFiles()} disabled={locked}>
          <FileUp className="size-4" />
          Add jar files…
        </Button>
        {updates && updates.length > 0 && (
          <Button variant="primary" onClick={() => void planUpdate(updates)} disabled={locked}>
            <ArrowUpCircle className="size-4" />
            Update all ({updates.length})
          </Button>
        )}
        <div className="ml-auto flex flex-wrap gap-1">
          {(Object.keys(LABELS) as CompatLabel[])
            .filter((l) => counts[l])
            .map((l) => (
              <Badge key={l} tone={LABELS[l].tone}>
                {counts[l]} {LABELS[l].text.toLowerCase()}
              </Badge>
            ))}
        </div>
      </div>
      {!list.providerChecked && <p className="text-sm text-warn">Could not reach Modrinth, so labels rely on what each mod says about itself.</p>}
      {list.mods.length === 0 ? (
        <EmptyState icon={<Package className="size-8" />} title="No mods installed">
          Add mods from Modrinth or CurseForge, or add jar files you already have.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.mods.map((m) => {
            const update = updateFor(m.file);
            const showReasons = m.label === "conflict" || m.label === "incompatible";
            return (
              <li key={m.file} className={cn("flex gap-3 p-3", !m.enabled && "opacity-60")}>
                {m.iconUrl ? <img src={m.iconUrl} alt="" className="size-10 shrink-0 rounded-md" /> : <div className="size-10 shrink-0 rounded-md bg-surface-2" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {m.source ? (
                      <a href={m.source.page} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                        {m.name}
                      </a>
                    ) : (
                      <span className="font-medium">{m.name}</span>
                    )}
                    {m.version && <span className="text-xs text-muted">{m.version}</span>}
                    <span title={m.reasons.join("\n")}>
                      <Badge tone={LABELS[m.label].tone}>{LABELS[m.label].text}</Badge>
                    </span>
                    {!m.enabled && <Badge>Switched off</Badge>}
                    {update && <Badge tone="accent">Update: {update.newVersion}</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {m.file} · {formatBytes(m.size)}
                  </div>
                  {showReasons && (
                    <ul className="mt-1 list-disc pl-4 text-xs">
                      {m.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex shrink-0 items-start gap-1">
                  {update && (
                    <Button variant="ghost" disabled={locked} onClick={() => void planUpdate([update])} aria-label={`Update ${m.name}`}>
                      <ArrowUpCircle className="size-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() => void run(() => call("mods:set-enabled", { id: server.id, files: [m.file], enabled: !m.enabled }))}
                    aria-label={m.enabled ? `Switch off ${m.name}` : `Switch on ${m.name}`}
                    title={m.enabled ? "Switch off" : "Switch on"}
                  >
                    {m.enabled ? <PowerOff className="size-4" /> : <Power className="size-4" />}
                  </Button>
                  <Button variant="ghost" disabled={locked} onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`} title="Remove">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {removing && (
        <Dialog
          title={`Remove ${removing.name}?`}
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const file = removing.file;
                  setRemoving(null);
                  void run(() => call("mods:remove", { id: server.id, files: [file] }));
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p>The file is moved into this server's mod history, not deleted. You can undo this from the History tab.</p>
        </Dialog>
      )}
    </>
  );
}

function AddMods({ server, locked, onPlan }: { server: ServerInstance; locked: boolean; onPlan: (p: ModChangePlan) => void }) {
  const [provider, setProvider] = useState<ModProvider>("modrinth");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PackSearchHit[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PackSearchHit | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setError(null);
      call("mods:search", { id: server.id, provider, query })
        .then((r) => {
          setHits(r.hits);
          setAvailable(r.available);
        })
        .catch((e: Error) => setError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [server.id, provider, query]);

  return (
    <Card
      title={`Mods for Minecraft ${server.minecraftVersion} on ${LOADER_LABEL[server.type] ?? server.type}`}
      actions={
        <div role="tablist" className="flex gap-1">
          {(["modrinth", "curseforge"] as ModProvider[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={provider === p}
              onClick={() => {
                setProvider(p);
                setSelected(null);
                setHits(null);
              }}
              className={cn("rounded-md px-2.5 py-1 text-sm", provider === p ? "bg-accent/15 font-medium" : "text-muted hover:text-text")}
            >
              {p === "modrinth" ? "Modrinth" : "CurseForge"}
            </button>
          ))}
        </div>
      }
    >
      {selected ? (
        <VersionChooser server={server} hit={selected} locked={locked} onBack={() => setSelected(null)} onPlan={onPlan} />
      ) : (
        <>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted" />
            <input className={cn(inputClass, "w-full pl-8")} placeholder="Search mods" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search mods" />
          </div>
          {provider === "curseforge" && !available && <p className="mb-3 text-sm text-warn">CurseForge needs an API key and this build has none. Add your own key in Settings, or use Modrinth.</p>}
          {error && <p className="mb-3 text-sm text-bad">{error}</p>}
          {hits && hits.length === 0 && available ? (
            <EmptyState icon={<Package className="size-8" />} title="No mods found for this server" />
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {hits?.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => setSelected(h)} className="flex w-full gap-3 rounded-lg border border-border p-3 text-left hover:border-accent">
                    {h.iconUrl ? <img src={h.iconUrl} alt="" className="size-10 shrink-0 rounded-md" /> : <div className="size-10 shrink-0 rounded-md bg-surface-2" />}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{h.title}</div>
                      <div className="truncate text-xs text-muted">
                        by {h.author || "unknown"} · {h.downloads.toLocaleString()} downloads
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted">{h.description}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function VersionChooser({ server, hit, locked, onBack, onPlan }: { server: ServerInstance; hit: PackSearchHit; locked: boolean; onBack: () => void; onPlan: (p: ModChangePlan) => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [versionId, setVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call("mods:versions", { id: server.id, provider: hit.source, projectId: hit.id })
      .then((v) => {
        setVersions(v);
        setVersionId((v.find((x) => x.stable) ?? v[0])?.id ?? "");
      })
      .catch((e: Error) => toast.error(e.message));
  }, [server.id, hit]);

  const plan = async () => {
    setBusy(true);
    try {
      onPlan(await call("mods:plan-add", { id: server.id, provider: hit.source, projectId: hit.id, versionId: versionId || null }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <button type="button" className="text-sm text-muted hover:text-text" onClick={onBack}>
        ← Back to results
      </button>
      <div className="flex items-center gap-3">
        {hit.iconUrl && <img src={hit.iconUrl} alt="" className="size-10 rounded-md" />}
        <div>
          <div className="font-semibold">{hit.title}</div>
          <div className="text-xs text-muted">{hit.description}</div>
        </div>
      </div>
      {versions && versions.length === 0 ? (
        <p className="text-sm text-warn">
          {hit.title} has no version for Minecraft {server.minecraftVersion} on {LOADER_LABEL[server.type] ?? server.type}.
        </p>
      ) : (
        <Field label="Version">
          <select className={cn(inputClass, "w-full")} value={versionId} onChange={(e) => setVersionId(e.target.value)} disabled={!versions}>
            {!versions && <option>Loading…</option>}
            {versions?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.stable ? "" : " (beta)"} · {formatTime(v.date)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Button variant="primary" disabled={busy || locked || !versionId} onClick={() => void plan()}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        Review and add
      </Button>
    </div>
  );
}

function PlanDialog({ plan, locked, onClose, onApplied }: { plan: ModChangePlan; locked: boolean; onClose: () => void; onApplied: (summary: string) => void }) {
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    try {
      onApplied((await call("mods:apply", { planId: plan.id })).summary);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Review the change"
      onClose={() => !busy && onClose()}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void apply()} disabled={busy || locked}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Apply
          </Button>
        </>
      }
    >
      {plan.files.length > 0 && (
        <ul className="space-y-1">
          {plan.files.map((f) => (
            <li key={`${f.provider}-${f.projectId}`} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{f.name}</span>
              <span className="text-xs text-muted">{f.version}</span>
              {f.reason === "dependency" && <Badge>Required by another mod</Badge>}
              {f.reason === "update" && <Badge tone="accent">Update</Badge>}
              {f.replaces && <span className="text-xs text-muted">replaces {f.replaces}</span>}
            </li>
          ))}
        </ul>
      )}
      {plan.manual.length > 0 && (
        <div>
          <p className="font-medium">Download these yourself</p>
          <p className="text-xs text-muted">Their authors do not allow apps to download them. They will be listed on this page until you add them.</p>
          <ul className="mt-1 list-disc pl-4">
            {plan.manual.map((m) => (
              <li key={m.path}>
                <a href={m.page} target="_blank" rel="noreferrer" className="text-accent-strong underline">
                  {m.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.warnings.map((w) => (
        <p key={w} className="flex gap-2 text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {w}
        </p>
      ))}
      <p className="text-xs text-muted">Files this replaces are kept in the mod history, so you can undo this change.</p>
    </Dialog>
  );
}

function HistoryView({ server, locked, version, run }: { server: ServerInstance; locked: boolean; version: number; run: (fn: () => Promise<{ summary: string }>) => Promise<void> }) {
  const [entries, setEntries] = useState<ModHistoryEntry[] | null>(null);
  useEffect(() => {
    call("mods:history", { id: server.id })
      .then(setEntries)
      .catch((e: Error) => toast.error(e.message));
  }, [server.id, version]);
  if (!entries) return <Loader2 className="size-5 animate-spin text-muted" />;
  if (!entries.length)
    return (
      <EmptyState icon={<History className="size-8" />} title="No changes yet">
        Changes you make to this server's mods appear here and can be undone.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className={cn("text-sm", e.undone && "text-muted line-through")}>{e.summary}</div>
            <div className="text-xs text-muted">{formatTime(e.at)}</div>
          </div>
          {e.undone ? (
            <Badge>Undone</Badge>
          ) : (
            <Button
              variant="ghost"
              disabled={locked || !e.canUndo}
              title={e.canUndo ? undefined : "The files this change touched have changed since"}
              onClick={() => void run(() => call("mods:undo", { id: server.id, entryId: e.id }))}
            >
              <Undo2 className="size-4" />
              Undo
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
