/**
 * NexCraft main process entry: creates the window, wires services to IPC, and
 * handles safe shutdown of anything still running.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EventName, EventPayload } from "../shared/ipc";
import { APP_VERSION, BUILT_IN_CURSEFORGE_KEY, USER_AGENT } from "./build-config";
import { resolveDataDir } from "./core/data-dir";
import { DownloadQueue } from "./core/download-queue";
import { Logger } from "./core/logger";
import { ProcessHost } from "./core/process-host";
import { registerIpc } from "./ipc/router";
import { StateService } from "./services/state-service";

const DEV_URL = process.env.NEXCRAFT_DEV_URL || "";
const BACKGROUND = "#0f0d16";

app.setName("NexCraft");
app.setAppUserModelId("io.github.saiki1997.nexcraft");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main() {
  await app.whenReady();

  const exeDir = path.dirname(app.getPath("exe"));
  const data = resolveDataDir({
    exeDir,
    userDataDir: app.getPath("userData"),
    isPackaged: app.isPackaged,
    devDir: path.join(app.getAppPath(), "data"),
  });
  const logsDir = path.join(data.dataDir, "logs");
  const logger = new Logger(logsDir, app.isPackaged ? "info" : "debug");
  const log = logger.scope("app");
  logger.addSecret(BUILT_IN_CURSEFORGE_KEY);
  try {
    logger.prune(14);
  } catch (err) {
    log.warn(`Could not prune old logs: ${(err as Error).message}`);
  }
  log.info(`NexCraft ${APP_VERSION} starting (${data.portable ? "portable" : app.isPackaged ? "installed" : "development"} data at ${data.dataDir})`);
  if (data.warning) log.warn(data.warning);

  const sealer = {
    available: () => safeStorage.isEncryptionAvailable(),
    seal: (plain: string) => safeStorage.encryptString(plain).toString("base64"),
    unseal: (sealed: string) => safeStorage.decryptString(Buffer.from(sealed, "base64")),
  };
  const state = new StateService(data.dataDir, sealer, logger.scope("state"));
  logger.addSecret(state.curseforgeKeyOverride());

  let mainWindow: BrowserWindow | null = null;
  const send = <E extends EventName>(event: E, payload: EventPayload[E]) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, payload);
  };

  const downloads = new DownloadQueue({
    userAgent: USER_AGENT,
    concurrency: state.snapshot().settings.maxParallelDownloads,
    log: logger.scope("downloads"),
    onChange: (jobs) => {
      state.recordJobs(jobs);
      send("jobs:changed", state.jobs());
    },
  });
  const processes = new ProcessHost();
  logger.onEntry((entry) => send("log:entry", entry));

  const folderFor = (which: "data" | "logs" | "servers" | "backups") => {
    const s = state.snapshot().settings;
    if (which === "data") return data.dataDir;
    if (which === "logs") return logsDir;
    if (which === "servers") return s.serversDir || path.join(data.dataDir, "servers");
    return s.backupsDir || path.join(data.dataDir, "backups");
  };

  const rendererIndex = path.join(__dirname, "../renderer/index.html");
  const rendererUrl = pathToFileURL(rendererIndex).toString();
  const isTrustedSender = (url: string) => {
    if (!url) return false;
    if (DEV_URL && !app.isPackaged) return url.startsWith(DEV_URL);
    return url.split("#")[0].split("?")[0] === rendererUrl;
  };

  registerIpc(
    ipcMain,
    {
      "app:info": () => ({
        name: "NexCraft",
        version: APP_VERSION,
        platform: process.platform,
        arch: process.arch,
        portable: data.portable,
        dataDir: data.dataDir,
        logsDir,
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
        cpuCount: os.cpus().length,
        curseforgeKey: state.curseforgeKeyOverride() ? "override" : BUILT_IN_CURSEFORGE_KEY ? "built-in" : "none",
        recoveredFrom: state.loadResult.problem,
      }),
      "settings:get": () => state.settingsView(),
      "settings:update": (patch) => {
        const view = state.updateSettings(patch);
        if (patch.maxParallelDownloads) downloads.setConcurrency(patch.maxParallelDownloads);
        return view;
      },
      "settings:set-curseforge-key": ({ key }) => {
        const view = state.setCurseforgeKey(key || null);
        logger.addSecret(key);
        return view;
      },
      "servers:list": () => state.servers(),
      "jobs:list": () => state.jobs(),
      "jobs:cancel": ({ id }) => downloads.cancel(id),
      "jobs:clear-finished": () => {
        downloads.clearFinished();
        const jobs = state.clearFinishedJobs();
        send("jobs:changed", jobs);
        return jobs;
      },
      "logs:recent": ({ limit }) => logger.recent(limit),
      "shell:open-folder": async ({ which }) => {
        const dir = folderFor(which);
        fs.mkdirSync(dir, { recursive: true });
        return (await shell.openPath(dir)) === "";
      },
      "dialog:pick-folder": async ({ purpose }) => {
        const titles = { servers: "Choose where new servers are created", java: "Choose where Java runtimes are stored", backups: "Choose where backups are saved" };
        const options: Electron.OpenDialogOptions = { title: titles[purpose], properties: ["openDirectory", "createDirectory"] };
        const res = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        return res.canceled ? null : (res.filePaths[0] ?? null);
      },
    },
    isTrustedSender,
    logger.scope("ipc"),
  );

  lockDownWebContents(isTrustedSender);
  Menu.setApplicationMenu(null);

  const createWindow = () => {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 620,
      title: "NexCraft",
      backgroundColor: BACKGROUND,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("closed", () => (mainWindow = null));
    if (DEV_URL && !app.isPackaged) void mainWindow.loadURL(DEV_URL);
    else void mainWindow.loadFile(rendererIndex);
  };
  createWindow();

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    const running = processes.runningIds();
    if (running.length > 0) {
      event.preventDefault();
      void (async () => {
        if (state.snapshot().settings.onQuit === "ask") {
          const choice = await dialog.showMessageBox({
            type: "question",
            buttons: ["Stop servers and quit", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            title: "Servers are running",
            message: `${running.length} server(s) are still running.`,
            detail: "NexCraft will send each server the stop command and wait for it to save its world before quitting.",
          });
          if (choice.response !== 0) return;
        }
        for (const id of running) {
          const result = await processes.stop(id, { timeoutMs: 90_000 });
          if (result === "timeout") log.warn(`Server ${id} did not stop within 90 seconds; it was left running`);
        }
        quitting = true;
        app.quit();
      })();
      return;
    }
    quitting = true;
    downloads.cancelAll();
    state.saveNow();
    log.info("NexCraft shutting down");
  });

  app.on("window-all-closed", () => app.quit());
}

/** Keep NexCraft's window on NexCraft's own pages; everything else opens in the browser. */
function lockDownWebContents(isTrusted: (url: string) => boolean) {
  const openExternal = (target: string) => {
    try {
      const u = new URL(target);
      if (u.protocol === "https:") void shell.openExternal(u.toString());
    } catch {
      // Not a URL; ignore.
    }
  };
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (isTrusted(url)) return;
      event.preventDefault();
      openExternal(url);
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  });
}
