import { Download, FileArchive, Link2, Loader2, Package, Search, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ImportSummary, ManualFile, PackSearchHit } from "../../shared/modpacks";
import { memoryWarning } from "../../shared/servers";
import { Badge, Button, Card, EmptyState, Field, inputClass, PageHeader } from "../components/ui";
import { call, subscribe } from "../lib/api";
import { cn, formatBytes } from "../lib/format";
import { refreshServers, useAppInfo } from "../lib/store";

type Source = "modrinth" | "curseforge";
type Version = { id: string; name: string; gameVersions: string[]; loaders: string[]; date: string; stable: boolean };

const LOADER_LABEL: Record<string, string> = { fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };

export function ModpacksPage({ onInstalled }: { onInstalled: (serverId: string) => void }) {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const inspect = async (label: string, fn: () => Promise<ImportSummary | null>) => {
    setBusy(label);
    try {
      const s = await fn();
      if (s) setSummary(s);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (summary) return <ImportView summary={summary} onBack={() => setSummary(null)} onInstalled={onInstalled} />;

  return (
    <>
      <PageHeader title="Modpacks" description="Turn a Modrinth or CurseForge modpack into a server. NexCraft shows you what it will install before it changes anything." />
      <div className="grid max-w-5xl gap-4">
        <ImportOther busy={busy} onInspect={inspect} />
        <Browser busy={busy} onInspect={inspect} />
      </div>
    </>
  );
}

function ImportOther({ busy, onInspect }: { busy: string | null; onInspect: (label: string, fn: () => Promise<ImportSummary | null>) => void }) {
  const [link, setLink] = useState("");
  return (
    <Card title="Import a file or link">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!!busy} onClick={() => onInspect("file", () => call("modpacks:inspect", { source: "file" }))}>
          {busy === "file" ? <Loader2 className="size-4 animate-spin" /> : <FileArchive className="size-4" />}
          Choose .mrpack or .zip…
        </Button>
        <span className="text-sm text-muted">or</span>
        <input
          className={cn(inputClass, "min-w-72 flex-1")}
          placeholder="Paste a modrinth.com or curseforge.com modpack link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          aria-label="Modpack link"
        />
        <Button variant="primary" disabled={!!busy || !link.trim()} onClick={() => onInspect("link", () => call("modpacks:inspect", { source: "link", link: link.trim() }))}>
          {busy === "link" ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
          Check pack
        </Button>
      </div>
    </Card>
  );
}

function Browser({ busy, onInspect }: { busy: string | null; onInspect: (label: string, fn: () => Promise<ImportSummary | null>) => void }) {
  const [source, setSource] = useState<Source>("modrinth");
  const [query, setQuery] = useState("");
  const [loader, setLoader] = useState("");
  const [hits, setHits] = useState<PackSearchHit[] | null>(null);
  const [cfAvailable, setCfAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PackSearchHit | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setError(null);
      call("modpacks:search", { source, query, loader: (loader || undefined) as never })
        .then((r) => {
          setHits(r.hits);
          setCfAvailable(r.available);
        })
        .catch((e: Error) => setError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [source, query, loader]);

  return (
    <Card
      title="Browse"
      actions={
        <div role="tablist" className="flex gap-1">
          {(["modrinth", "curseforge"] as Source[]).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={source === s}
              onClick={() => {
                setSource(s);
                setSelected(null);
                setHits(null);
              }}
              className={cn("rounded-md px-2.5 py-1 text-sm", source === s ? "bg-accent/15 font-medium" : "text-muted hover:text-text")}
            >
              {s === "modrinth" ? "Modrinth" : "CurseForge"}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted" />
          <input className={cn(inputClass, "w-full pl-8")} placeholder="Search modpacks" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search modpacks" />
        </div>
        <select className={inputClass} value={loader} onChange={(e) => setLoader(e.target.value)} aria-label="Loader">
          <option value="">Any loader</option>
          {Object.entries(LOADER_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {source === "curseforge" && !cfAvailable && (
        <p className="mb-3 text-sm text-warn">CurseForge needs an API key and this build has none. Add your own key in Settings, or use Modrinth.</p>
      )}
      {error && <p className="mb-3 text-sm text-bad">{error}</p>}
      {selected ? (
        <VersionPicker hit={selected} busy={busy} onBack={() => setSelected(null)} onInspect={onInspect} />
      ) : hits && hits.length === 0 && cfAvailable ? (
        <EmptyState icon={<Package className="size-8" />} title="No modpacks found" />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {hits?.map((h) => (
            <li key={`${h.source}-${h.id}`}>
              <button type="button" onClick={() => setSelected(h)} className="flex w-full gap-3 rounded-lg border border-border p-3 text-left hover:border-accent">
                {h.iconUrl ? <img src={h.iconUrl} alt="" className="size-12 shrink-0 rounded-md" /> : <div className="size-12 shrink-0 rounded-md bg-surface-2" />}
                <div className="min-w-0">
                  <div className="truncate font-medium">{h.title}</div>
                  <div className="truncate text-xs text-muted">
                    by {h.author || "unknown"} · {h.downloads.toLocaleString()} downloads
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted">{h.description}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {h.loaders.map((l) => (
                      <Badge key={l}>{LOADER_LABEL[l] ?? l}</Badge>
                    ))}
                    {h.gameVersions.slice(0, 3).map((v) => (
                      <Badge key={v}>{v}</Badge>
                    ))}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function VersionPicker({
  hit,
  busy,
  onBack,
  onInspect,
}: {
  hit: PackSearchHit;
  busy: string | null;
  onBack: () => void;
  onInspect: (label: string, fn: () => Promise<ImportSummary | null>) => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [versionId, setVersionId] = useState("");
  useEffect(() => {
    call("modpacks:versions", { source: hit.source, projectId: hit.id })
      .then((v) => {
        setVersions(v);
        setVersionId((v.find((x) => x.stable) ?? v[0])?.id ?? "");
      })
      .catch((e: Error) => toast.error(e.message));
  }, [hit]);
  return (
    <div className="space-y-3">
      <button type="button" className="text-sm text-muted hover:text-text" onClick={onBack}>
        ← Back to results
      </button>
      <div className="flex items-center gap-3">
        {hit.iconUrl && <img src={hit.iconUrl} alt="" className="size-12 rounded-md" />}
        <div>
          <div className="font-semibold">{hit.title}</div>
          <div className="text-xs text-muted">{hit.description}</div>
        </div>
      </div>
      <Field label="Version">
        <select className={cn(inputClass, "w-full")} value={versionId} onChange={(e) => setVersionId(e.target.value)} disabled={!versions}>
          {!versions && <option>Loading…</option>}
          {versions?.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · Minecraft {v.gameVersions.join(", ")}
              {v.loaders.length ? ` · ${v.loaders.map((l) => LOADER_LABEL[l] ?? l).join(", ")}` : ""}
              {v.stable ? "" : " (beta)"}
            </option>
          ))}
        </select>
      </Field>
      <Button variant="primary" disabled={!!busy || !versionId} onClick={() => onInspect("browse", () => call("modpacks:inspect", { source: hit.source, projectId: hit.id, versionId }))}>
        {busy === "browse" && <Loader2 className="size-4 animate-spin" />}
        Check what this pack installs
      </Button>
    </div>
  );
}

function ImportView({ summary, onBack, onInstalled }: { summary: ImportSummary; onBack: () => void; onInstalled: (id: string) => void }) {
  const info = useAppInfo();
  const [name, setName] = useState(summary.name.slice(0, 64));
  const [memoryMb, setMemoryMb] = useState(6144);
  const [port, setPort] = useState(25565);
  const [useServerPack, setUseServerPack] = useState(Boolean(summary.serverPack));
  const [progress, setProgress] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ serverId: string; clientOnlyRemoved: string[]; manual: ManualFile[] } | null>(null);
  const warning = info ? memoryWarning(memoryMb, info.totalMemoryMb) : null;

  const install = async () => {
    const progressKey = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    setBusy(true);
    setProgress([]);
    const off = subscribe("server:install", (p) => {
      if (p.key === progressKey) setProgress((prev) => [...prev.slice(-200), p.message]);
    });
    try {
      const r = await call("modpacks:install", { planId: summary.id, progressKey, name: name.trim(), memoryMb, port, useServerPack });
      refreshServers();
      setResult({ serverId: r.server.id, clientOnlyRemoved: r.clientOnlyRemoved, manual: r.manual });
      toast.success(`${r.server.name} is ready`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      off();
      setBusy(false);
    }
  };

  if (result) {
    return (
      <>
        <PageHeader title={`${name} is installed`} description="Accept the Minecraft EULA on the server's page to start it." />
        <div className="grid max-w-3xl gap-4">
          {result.clientOnlyRemoved.length > 0 && (
            <Card title="Client-only mods set aside">
              <p className="mb-2 text-sm text-muted">These mods say they only work in the game client, so they were moved to the server's .nexcraft/client-only-mods folder.</p>
              <p className="text-sm">{result.clientOnlyRemoved.join(", ")}</p>
            </Card>
          )}
          {result.manual.length > 0 && <ManualDownloads serverId={result.serverId} initial={result.manual} />}
          <div>
            <Button variant="primary" onClick={() => onInstalled(result.serverId)}>
              Open the server
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <button type="button" className="mb-3 text-sm text-muted hover:text-text" onClick={onBack} disabled={busy}>
        ← Choose another pack
      </button>
      <PageHeader title={`${summary.name} ${summary.version}`} description="Nothing has been installed yet. Check the details, then create the server." />
      <div className="grid max-w-5xl gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid gap-4">
          <Card title="What this pack needs">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Fact label="Minecraft" value={summary.minecraftVersion} />
              <Fact label="Loader" value={summary.loader ? `${LOADER_LABEL[summary.loader.type]} ${summary.loader.version}` : "None (Vanilla)"} />
              <Fact label="Files for the server" value={String(summary.serverFileCount)} />
              <Fact label="Client-only, skipped" value={String(summary.clientOnly.length)} />
            </dl>
            {summary.unknownSide > 0 && (
              <p className="mt-3 text-xs text-muted">
                {summary.unknownSide} files do not say whether they run on servers. NexCraft installs them and checks each mod's own metadata afterwards, setting aside any that are client-only.
              </p>
            )}
          </Card>
          {summary.serverPack && (
            <Card title="Official server pack">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={useServerPack} onChange={(e) => setUseServerPack(e.target.checked)} />
                <span>
                  Use the pack author's server pack ({summary.serverPack.fileName}, {formatBytes(summary.serverPack.size)}). Recommended: the author chose which mods and configs the server needs.
                </span>
              </label>
            </Card>
          )}
          {summary.manual.length > 0 && !useServerPack && (
            <Card title={`${summary.manual.length} files to download yourself`}>
              <p className="mb-2 text-sm text-muted">
                The authors of these mods do not allow apps to download them. After the server is created, download each one from its page and add it. NexCraft checks that each file is the exact one the pack expects.
              </p>
              <ul className="space-y-1 text-sm">
                {summary.manual.map((m) => (
                  <li key={m.path}>
                    <a href={m.page} target="_blank" rel="noreferrer" className="text-accent-strong underline">
                      {m.name}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {summary.clientOnly.length > 0 && (
            <Card title="Client-only files that will be skipped">
              <p className="text-sm text-muted">{summary.clientOnly.join(", ")}</p>
            </Card>
          )}
          {summary.warnings.length > 0 && (
            <Card title="Warnings">
              <ul className="space-y-1 text-sm">
                {summary.warnings.map((w) => (
                  <li key={w} className="flex gap-2">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
                    {w}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <Card title="Create the server">
          <div className="space-y-3">
            <Field label="Server name">
              <input className={cn(inputClass, "w-full")} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={`Memory: ${(memoryMb / 1024).toFixed(1)} GB`} hint={warning ? <span className="text-warn">{warning}</span> : "Most modpacks need 6 to 10 GB."}>
              <input
                type="range"
                min={2048}
                max={info ? Math.min(65536, Math.max(4096, Math.floor(info.totalMemoryMb / 512) * 512)) : 16384}
                step={512}
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
                className="w-full accent-[var(--accent)]"
              />
            </Field>
            <Field label="Port">
              <input type="number" min={1024} max={65535} className={cn(inputClass, "w-full")} value={port} onChange={(e) => setPort(Number(e.target.value))} />
            </Field>
            <Button variant="primary" className="w-full justify-center" disabled={busy || !name.trim()} onClick={() => void install()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {busy ? "Installing…" : "Create server"}
            </Button>
            {progress.length > 0 && <p className="text-xs break-words text-muted">{progress.at(-1)}</p>}
          </div>
        </Card>
      </div>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/** Files the user must download by hand, with a button to add them once downloaded. */
export function ManualDownloads({ serverId, initial }: { serverId: string; initial?: ManualFile[] }) {
  const [files, setFiles] = useState<ManualFile[] | null>(initial ?? null);
  useEffect(() => {
    if (!initial) call("modpacks:manual-files", { id: serverId }).then(setFiles).catch(() => setFiles([]));
  }, [serverId, initial]);
  if (!files || files.length === 0) return null;

  const add = async () => {
    try {
      const r = await call("modpacks:add-manual-files", { id: serverId });
      if (!r) return;
      if (r.added.length) toast.success(`Added ${r.added.join(", ")}`);
      if (r.rejected.length) toast.error(`${r.rejected.join(", ")} did not match any file the pack expects`);
      setFiles(await call("modpacks:manual-files", { id: serverId }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Card title={`${files.length} mods still need to be downloaded by hand`} className="border-warn/40">
      <p className="mb-2 text-sm text-muted">Their authors do not allow apps to download them. Open each page, download the file, then add the files here.</p>
      <ul className="mb-3 space-y-1 text-sm">
        {files.map((m) => (
          <li key={m.path}>
            <a href={m.page} target="_blank" rel="noreferrer" className="text-accent-strong underline">
              {m.name}
            </a>
          </li>
        ))}
      </ul>
      <Button variant="primary" onClick={() => void add()}>
        Add downloaded files…
      </Button>
    </Card>
  );
}
