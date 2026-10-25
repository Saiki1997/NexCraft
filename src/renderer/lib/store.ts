import { useEffect, useState } from "react";
import type { AppInfo, LogEntry, SettingsView } from "../../shared/ipc";
import type { Job, ServerInstance } from "../../shared/model";
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

export function useServers(): ServerInstance[] | null {
  const [servers, setServers] = useState<ServerInstance[] | null>(null);
  useEffect(() => {
    if (!hasBridge()) return;
    void call("servers:list", {}).then(setServers).catch(() => setServers([]));
  }, []);
  return servers;
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
