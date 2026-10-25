import { Archive, Boxes, Download, LayoutDashboard, Package, PlusCircle, Server, Settings, Stethoscope } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { call, hasBridge } from "./lib/api";
import { cn } from "./lib/format";
import { DashboardPage } from "./pages/dashboard";
import { DiagnosticsPage } from "./pages/diagnostics";
import { DownloadsPage } from "./pages/downloads";
import { CreateServerPage } from "./pages/create-server";
import { BackupsPage } from "./pages/planned";
import { ModsPage } from "./pages/mods";
import { ModpacksPage } from "./pages/modpacks";
import { ServersPage } from "./pages/servers";
import { SettingsPage } from "./pages/settings";
import type { SettingsView } from "../shared/ipc";

export type Page = "dashboard" | "servers" | "create" | "modpacks" | "mods" | "downloads" | "backups" | "diagnostics" | "settings";

const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="size-4" /> },
  { id: "servers", label: "Servers", icon: <Server className="size-4" /> },
  { id: "create", label: "Create server", icon: <PlusCircle className="size-4" /> },
  { id: "modpacks", label: "Modpacks", icon: <Package className="size-4" /> },
  { id: "mods", label: "Mods", icon: <Boxes className="size-4" /> },
  { id: "downloads", label: "Downloads", icon: <Download className="size-4" /> },
  { id: "backups", label: "Backups", icon: <Archive className="size-4" /> },
  { id: "diagnostics", label: "Diagnostics", icon: <Stethoscope className="size-4" /> },
  { id: "settings", label: "Settings", icon: <Settings className="size-4" /> },
];

function applyTheme(theme: SettingsView["theme"]) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const openServer = (id: string | null) => {
    setSelectedServer(id);
    setPage("servers");
  };

  useEffect(() => {
    if (!hasBridge()) return;
    void call("settings:get", {}).then((s) => applyTheme(s.theme)).catch(() => undefined);
  }, []);

  if (!hasBridge()) {
    return <div className="p-8 text-sm">NexCraft's desktop bridge is missing. Start NexCraft from NexCraft.exe.</div>;
  }

  return (
    <div className="flex h-full">
      <nav aria-label="Main" className="flex w-56 shrink-0 flex-col border-r border-border bg-surface px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-2">
          <Logo />
          <span className="text-base font-semibold tracking-tight">NexCraft</span>
        </div>
        <ul className="space-y-0.5">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  setPage(item.id);
                  if (item.id === "servers") setSelectedServer(null);
                }}
                aria-current={page === item.id ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  page === item.id ? "bg-accent/15 text-text font-medium" : "text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                <span className={page === item.id ? "text-accent-strong" : undefined}>{item.icon}</span>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-w-0 flex-1 overflow-auto px-8 py-6">
        {page === "dashboard" && <DashboardPage go={setPage} openServer={openServer} />}
        {page === "servers" && <ServersPage selected={selectedServer} onSelect={setSelectedServer} onCreate={() => setPage("create")} />}
        {page === "create" && <CreateServerPage onCreated={openServer} />}
        {page === "modpacks" && <ModpacksPage onInstalled={openServer} />}
        {page === "mods" && <ModsPage />}
        {page === "downloads" && <DownloadsPage />}
        {page === "backups" && <BackupsPage />}
        {page === "diagnostics" && <DiagnosticsPage />}
        {page === "settings" && <SettingsPage onTheme={applyTheme} />}
      </main>
      <Toaster theme="system" position="bottom-right" richColors closeButton />
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="var(--accent)" />
      <path d="M9 23V9h3.2l7.6 9.2V9H23v14h-3.2L12.2 13.8V23z" fill="var(--accent-ink)" />
    </svg>
  );
}
