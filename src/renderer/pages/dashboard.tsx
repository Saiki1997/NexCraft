import { Cpu, FolderOpen, HardDrive, KeyRound, Server, TriangleAlert } from "lucide-react";
import { call } from "../lib/api";
import { formatTime } from "../lib/format";
import { useAppInfo, useJobs, useServers, useServerStatuses } from "../lib/store";
import { Badge, Button, Card, EmptyState, PageHeader } from "../components/ui";
import type { Page } from "../app";

export function DashboardPage({ go, openServer }: { go: (p: Page) => void; openServer: (id: string) => void }) {
  const info = useAppInfo();
  const servers = useServers();
  const statuses = useServerStatuses();
  const jobs = useJobs();
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued");

  return (
    <>
      <PageHeader title="Dashboard" description="Your servers, background tasks and this PC at a glance." />
      {info?.recoveredFrom && (
        <div role="alert" className="mb-4 flex gap-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <div>
            NexCraft could not read its saved state and started from a backup or defaults. {info.recoveredFrom}. The unreadable file was kept in the
            data folder.
          </div>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Servers" className="lg:col-span-2">
          {servers && servers.length > 0 ? (
            <ul className="divide-y divide-border">
              {servers.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                  <button type="button" className="font-medium hover:text-accent-strong" onClick={() => openServer(s.id)}>
                    {s.name}
                  </button>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {s.type} {s.minecraftVersion}
                    {statuses[s.id]?.state === "running" && <Badge tone="good">{statuses[s.id].players.length} online</Badge>}
                    {statuses[s.id]?.state === "crashed" && <Badge tone="bad">Crashed</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Server className="size-8" />} title="No servers yet">
              <p>Create a Vanilla server and it shows up here with its status and players.</p>
              <Button variant="primary" className="mt-3" onClick={() => go("create")}>
                Create server
              </Button>
            </EmptyState>
          )}
        </Card>
        <Card title="This PC">
          {info ? (
            <dl className="space-y-3 text-sm">
              <Row icon={<HardDrive className="size-4" />} label="Memory" value={`${(info.totalMemoryMb / 1024).toFixed(1)} GB installed`} />
              <Row icon={<Cpu className="size-4" />} label="Processor" value={`${info.cpuCount} logical cores`} />
              <Row
                icon={<KeyRound className="size-4" />}
                label="CurseForge"
                value={
                  info.curseforgeKey === "none" ? (
                    <Badge tone="warn">No API key</Badge>
                  ) : (
                    <Badge tone="good">{info.curseforgeKey === "override" ? "Your key" : "Built-in key"}</Badge>
                  )
                }
              />
              <Row
                icon={<FolderOpen className="size-4" />}
                label="Data"
                value={
                  <Button variant="ghost" className="-mx-2 px-2 py-0.5" onClick={() => void call("shell:open-folder", { which: "data" })}>
                    {info.portable ? "Portable folder" : "User profile"}
                  </Button>
                }
              />
            </dl>
          ) : (
            <p className="text-sm text-muted">Loading…</p>
          )}
        </Card>
        <Card
          title="Background tasks"
          className="lg:col-span-3"
          actions={
            <Button variant="ghost" onClick={() => go("downloads")}>
              Open Downloads
            </Button>
          }
        >
          {active.length === 0 ? (
            <p className="text-sm text-muted">Nothing running. Last task: {jobs.length ? `${jobs.at(-1)!.title}, ${formatTime(jobs.at(-1)!.updatedAt)}` : "none yet"}.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {active.map((j) => (
                <li key={j.id} className="flex justify-between">
                  <span>{j.title}</span>
                  <span className="text-muted">{j.progress != null ? `${Math.round(j.progress * 100)}%` : j.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-2 text-muted">
        {icon}
        {label}
      </dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
