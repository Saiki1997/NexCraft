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
import { JavaService } from "./java/java-service";
import { Loaders } from "./loaders/loaders";
import { ModpackService } from "./modpacks/modpack-service";
import { ModService } from "./mods/mod-service";
import { CurseForgeClient } from "./providers/curseforge";
import { ModrinthClient } from "./providers/modrinth";
import { modpackVersions, resolvePackLink, searchModpacks } from "./providers/search";
import { MojangClient } from "./minecraft/mojang";
import { PROPERTY_DEFS } from "./servers/server-properties";
import { ServerService } from "./servers/server-service";
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

  const settingsDir = (key: "serversDir" | "javaDir", fallback: string) => state.snapshot().settings[key] || path.join(data.dataDir, fallback);
  const java = new JavaService({
    state,
    downloads,
    log: logger.scope("java"),
    javaDir: () => settingsDir("javaDir", "java"),
    userAgent: USER_AGENT,
  });
  const mojang = new MojangClient(path.join(data.dataDir, "cache"), USER_AGENT);
  const loaders = new Loaders({ userAgent: USER_AGENT, cacheDir: path.join(data.dataDir, "cache") });
  const servers = new ServerService({
    state,
    processes,
    downloads,
    java,
    mojang,
    loaders,
    log: logger.scope("servers"),
    serversDir: () => settingsDir("serversDir", "servers"),
    emitStatus: (status) => send("server:status", status),
    emitConsole: (id, lines) => send("server:console", { id, lines }),
    emitInstall: (progress) => {
      send("server:install", progress);
      if (progress.step === "done") send("java:changed", java.list());
    },
  });
  const modrinth = new ModrinthClient(USER_AGENT);
  const curseforge = new CurseForgeClient(() => state.curseforgeKeyOverride() ?? (BUILT_IN_CURSEFORGE_KEY || null), USER_AGENT);
  const modpacks = new ModpackService({
    servers,
    state,
    downloads,
    modrinth,
    curseforge,
    cacheDir: path.join(data.dataDir, "cache"),
    log: logger.scope("modpacks"),
  });
  const mods = new ModService({ state, servers, downloads, modrinth, curseforge, log: logger.scope("mods") });
  const serverById = (id: string) => {
    const server = state.server(id);
    if (!server) throw new Error("That server no longer exists");
    return server;
  };
  const pickFiles = async (title: string, filters: Electron.FileFilter[], multi: boolean) => {
    const options: Electron.OpenDialogOptions = { title, filters, properties: multi ? ["openFile", "multiSelections"] : ["openFile"] };
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return res.canceled ? [] : res.filePaths;
  };
  const javaChanged = <T>(value: T) => {
    send("java:changed", java.list());
    return value;
  };
  // Pick up runtimes installed since the last run, without holding up startup.
  void java.detect().then(javaChanged, (err) => log.warn(`Java scan failed: ${(err as Error).message}`));

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
      "servers:list": () => servers.list(),
      "servers:statuses": () => servers.statuses(),
      "servers:create": ({ input, progressKey }) => servers.create(input, progressKey),
      "servers:remove": ({ id }) => {
        servers.remove(id);
        return true;
      },
      "servers:accept-eula": ({ id }) => servers.acceptEula(id),
      "servers:start": ({ id }) => servers.start(id),
      "servers:stop": ({ id }) => servers.stop(id),
      "servers:force-stop": ({ id }) => servers.forceStop(id),
      "servers:restart": ({ id }) => servers.restart(id),
      "servers:send-command": ({ id, command }) => servers.sendCommand(id, command),
      "servers:console": ({ id }) => servers.console(id),
      "servers:get-properties": ({ id }) => ({ values: servers.readProperties(id), fields: PROPERTY_DEFS }),
      "servers:update-properties": ({ id, values }) => servers.updateProperties(id, values),
      "servers:update-resources": ({ id, patch }) => servers.updateResources(id, patch),
      "servers:open-folder": async ({ id }) => {
        const server = servers.list().find((s) => s.id === id);
        if (!server || !fs.existsSync(server.directory)) return false;
        return (await shell.openPath(server.directory)) === "";
      },
      "minecraft:versions": ({ includeSnapshots }) => mojang.versions(includeSnapshots),
      "loaders:versions": ({ type, minecraftVersion }) => loaders.versions(type, minecraftVersion),
      "modpacks:search": async (q) => {
        if (q.source === "curseforge" && !curseforge.available()) return { hits: [], available: false };
        return { hits: await searchModpacks(modrinth, curseforge, q), available: true };
      },
      "modpacks:versions": ({ source, projectId }) => modpackVersions(modrinth, curseforge, source, projectId),
      "modpacks:inspect": async (input) => {
        if (input.source === "file") {
          const [file] = await pickFiles("Choose a modpack", [{ name: "Modpacks", extensions: ["mrpack", "zip"] }], false);
          return file ? modpacks.inspectFile(file) : null;
        }
        if (input.source === "link") {
          const resolved = await resolvePackLink(modrinth, curseforge, input.link);
          if (!resolved) throw new Error("Paste a Modrinth or CurseForge modpack link");
          return resolved.source === "modrinth" ? modpacks.inspectModrinth(resolved.projectId, null) : modpacks.inspectCurseForge(Number(resolved.projectId), null);
        }
        return input.source === "modrinth"
          ? modpacks.inspectModrinth(input.projectId, input.versionId)
          : modpacks.inspectCurseForge(Number(input.projectId), input.versionId ? Number(input.versionId) : null);
      },
      "modpacks:install": ({ planId, progressKey, ...opts }) =>
        modpacks.install(planId, opts, progressKey, (message) => send("server:install", { key: progressKey, step: "modpack", message })),
      "modpacks:manual-files": ({ id }) => modpacks.manualFiles(serverById(id)),
      "modpacks:add-manual-files": async ({ id }) => {
        const files = await pickFiles("Choose the files you downloaded", [{ name: "Mods", extensions: ["jar", "zip"] }], true);
        return files.length ? modpacks.addManualFiles(serverById(id), files) : null;
      },
      "mods:list": ({ id }) => mods.list(id),
      "mods:search": async ({ id, provider, query }) => {
        if (provider === "curseforge" && !curseforge.available()) return { hits: [], available: false };
        return { hits: await mods.search(id, provider, query), available: true };
      },
      "mods:versions": ({ id, provider, projectId }) => mods.versions(id, provider, projectId),
      "mods:plan-add": ({ id, provider, projectId, versionId }) => mods.planAdd(id, provider, projectId, versionId),
      "mods:check-updates": ({ id }) => mods.checkUpdates(id),
      "mods:plan-update": ({ id, updates }) => mods.planUpdate(id, updates),
      "mods:apply": ({ planId }) => mods.apply(planId),
      "mods:add-files": async ({ id }) => {
        const files = await pickFiles("Choose mod files", [{ name: "Mods", extensions: ["jar"] }], true);
        return files.length ? mods.addFiles(id, files) : null;
      },
      "mods:set-enabled": ({ id, files, enabled }) => mods.setEnabled(id, files, enabled),
      "mods:remove": ({ id, files }) => mods.remove(id, files),
      "mods:history": ({ id }) => mods.history(id),
      "mods:undo": ({ id, entryId }) => mods.undo(id, entryId),
      "java:list": () => java.list(),
      "java:detect": async () => javaChanged(await java.detect()),
      "java:install": async ({ major }) => javaChanged(await java.install(major)),
      "java:add-custom": async () => {
        const options: Electron.OpenDialogOptions = {
          title: "Choose java.exe",
          properties: ["openFile"],
          filters: process.platform === "win32" ? [{ name: "Java", extensions: ["exe"] }] : [],
        };
        const res = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        if (res.canceled || !res.filePaths[0]) return null;
        return javaChanged(await java.addCustom(res.filePaths[0]));
      },
      "java:verify": async ({ id }) => javaChanged(await java.verify(id)),
      "java:forget": ({ id }) => javaChanged(java.forget(id)),
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
        const results = await servers.stopAll(90_000);
        const stuck = results.filter((r) => r.result === "timeout").map((r) => r.id);
        if (stuck.length > 0) {
          const names = stuck.map((id) => servers.list().find((s) => s.id === id)?.name ?? id).join(", ");
          log.warn(`Did not stop within 90 seconds: ${names}`);
          const choice = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Force stop and quit", "Keep NexCraft open"],
            defaultId: 1,
            cancelId: 1,
            title: "A server is not stopping",
            message: `${names} did not stop within 90 seconds.`,
            detail: "Force stopping ends the server without saving, so recent changes to the world can be lost.",
          });
          if (choice.response !== 0) return;
          for (const id of stuck) await servers.forceStop(id);
        }
        servers.dispose();
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
