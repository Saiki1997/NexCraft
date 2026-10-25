import { useCallback, useEffect, useState } from "react";
import type { AppInfo, LogEntry, SettingsView } from "../../shared/ipc";
import type { JavaRuntime, Job, ServerInstance } from "../../shared/model";
import type { ConsoleLine, ServerStatus } from "../../shared/servers";
import { call, hasBridge, subscribe } from "./api";

/** Load once from the main process and keep in sync with its push events. */
export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    if (!hasBridge()) return;
    void call("jobs:list", {}).then(setJobs).catch(() => undefined);
    return subscribe("jobs:changed", setJobs);
  }, []);
  return jobs;
}

const serverListeners = new Set<() => void>();

/** Tell every server list on screen to reload, e.g. after creating or removing a server. */
export function refreshServers() {
  for (const listener of serverListeners) listener();
}

export function useServers(): ServerInstance[] | null {
  const [servers, setServers] = useState<ServerInstance[] | null>(null);
  useEffect(() => {
    if (!hasBridge()) return;
    const load = () => void call("servers:list", {}).then(setServers).catch(() => setServers([]));
    load();
    serverListeners.add(load);
    // Status changes can update stored fields such as lastStartedAt.
    const off = subscribe("server:status", (s) => {
      if (s.state === "running" || s.state === "stopped") load();
    });
    return () => {
      serverListeners.delete(load);
      off();
    };
  }, []);
  return servers;
}

export function useServerStatuses(): Record<string, ServerStatus> {
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({});
  useEffect(() => {
    if (!hasBridge()) return;
    void call("servers:statuses", {})
      .then((list) => setStatuses((prev) => ({ ...Object.fromEntries(list.map((s) => [s.id, s])), ...prev })))
      .catch(() => undefined);
    return subscribe("server:status", (s) => setStatuses((prev) => ({ ...prev, [s.id]: s })));
  }, []);
  return statuses;
}

/** A server's console: what is buffered in the main process, then live lines. */
export function useConsole(id: string, limit = 5000): ConsoleLine[] {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  useEffect(() => {
    if (!hasBridge()) return;
    let lastSeq = 0;
    const append = (incoming: ConsoleLine[]) => {
      const fresh = incoming.filter((l) => l.seq > lastSeq);
      if (!fresh.length) return;
      lastSeq = fresh[fresh.length - 1].seq;
      setLines((prev) => [...prev, ...fresh].slice(-limit));
    };
    setLines([]);
    const off = subscribe("server:console", (batch) => {
      if (batch.id === id) append(batch.lines);
    });
    void call("servers:console", { id }).then(append).catch(() => undefined);
    return off;
  }, [id, limit]);
  return lines;
}

export function useJavaRuntimes(): [JavaRuntime[] | null, () => void] {
  const [list, setList] = useState<JavaRuntime[] | null>(null);
  const reload = useCallback(() => void call("java:list", {}).then(setList).catch(() => setList([])), []);
  useEffect(() => {
    if (!hasBridge()) return;
    reload();
    return subscribe("java:changed", setList);
  }, [reload]);
  return [list, reload];
}

export function useLogs(limit = 500): LogEntry[] {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  useEffect(() => {
    if (!hasBridge()) return;
    void call("logs:recent", { limit }).then(setLogs).catch(() => undefined);
    return subscribe("log:entry", (entry) => setLogs((prev) => [...prev.slice(-(limit - 1)), entry]));
  }, [limit]);
  return logs;
}

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (!hasBridge()) return;
    void call("app:info", {}).then(setInfo).catch(() => undefined);
  }, []);
  return info;
}

export function useSettings(): [SettingsView | null, (next: SettingsView) => void] {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  useEffect(() => {
    if (!hasBridge()) return;
    void call("settings:get", {}).then(setSettings).catch(() => undefined);
  }, []);
  return [settings, setSettings];
}
